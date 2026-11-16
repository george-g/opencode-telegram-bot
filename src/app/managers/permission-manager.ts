import type {
  GroupedPermissionMessage,
  PermissionOutcome,
  PermissionPromptChange,
  PermissionReply,
  PermissionRequest,
  PermissionState,
} from "../types/permission.js";
import type { InteractionManager } from "./interaction-manager.js";
import { DEFAULT_INTERACTION_SCOPE } from "../types/interaction-scope.js";
import { logger } from "../../utils/logger.js";

/**
 * Why a sent permission message was not registered. A stale or resolved
 * request is dropped; one refused because a poll holds the slot has to wait.
 */
export type StartPermissionResult = "started" | "stale" | "resolved" | "question_active";

function createEmptyState(): PermissionState {
  return {
    requestsByMessageId: new Map(),
    requestIdsByMessageId: new Map(),
    messageIdBySignature: new Map(),
    sendsByMessageId: new Map(),
  };
}

/**
 * Permission prompts of one interaction scope. Prompts live in the slot of their
 * own chat and topic, so a prompt in one topic never blocks, replaces or reads a
 * prompt of another. Every method takes the scope last and defaults to the
 * plain-chat one.
 */
export class PermissionManager {
  private resolvedRequestIDs = new Set<string>();
  private resolvedResetEpoch = 0;
  // Prompts on their way to Telegram, by signature: a second show of the same request
  // waits for the first to land instead of sending its own prompt.
  private presenting = new Map<string, Promise<void>>();

  constructor(private readonly interactionManager: InteractionManager) {}

  private stateOf(scope: string): PermissionState | null {
    return this.interactionManager.getPayload("permission", scope);
  }

  /**
   * Resolved ids live until a full reset forgets them. A scope-local clear bumps
   * only that scope's epoch, so the set is keyed to the full-reset epoch alone.
   */
  private getResolvedRequestIDs(): Set<string> {
    const resetEpoch = this.interactionManager.getResetEpoch();
    if (resetEpoch !== this.resolvedResetEpoch) {
      this.resolvedRequestIDs.clear();
      this.resolvedResetEpoch = resetEpoch;
    }

    return this.resolvedRequestIDs;
  }

  private getRequestSignature(request: PermissionRequest): string {
    return JSON.stringify({
      sessionID: request.sessionID,
      permission: request.permission,
      patterns: [...request.patterns].sort(),
    });
  }

  /**
   * Check whether a request can still be shown in the given generation of its own
   * scope. An omitted generation is the current one of that scope.
   */
  getDropReason(
    request: PermissionRequest,
    generation?: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): "stale" | "resolved" | null {
    if ((generation ?? this.getGeneration(scope)) !== this.getGeneration(scope)) {
      return "stale";
    }

    return this.getResolvedRequestIDs().has(request.id) ? "resolved" : null;
  }

  /** The send of a prompt with this request's signature, while one is on its way. */
  getPresenting(request: PermissionRequest): Promise<void> | undefined {
    return this.presenting.get(this.getRequestSignature(request));
  }

  /** Marks a prompt with this request's signature as on its way; the returned call ends that. */
  claimPresenting(request: PermissionRequest): () => void {
    const signature = this.getRequestSignature(request);
    let release = () => {};
    const landed = new Promise<void>((resolve) => {
      release = () => {
        if (this.presenting.get(signature) === landed) {
          this.presenting.delete(signature);
        }
        resolve();
      };
    });
    this.presenting.set(signature, landed);
    return release;
  }

  /**
   * Register a new permission request message
   */
  startPermission(
    request: PermissionRequest,
    messageId: number,
    generation?: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): StartPermissionResult {
    logger.debug(
      `[PermissionManager] startPermission: id=${request.id}, permission=${request.permission}, messageId=${messageId}, scope=${scope}`,
    );

    const dropReason = this.getDropReason(request, generation, scope);
    if (dropReason) {
      logger.debug(
        `[PermissionManager] Ignoring ${dropReason} request: id=${request.id}`,
      );
      return dropReason;
    }

    if (this.interactionManager.getSnapshot(scope)?.kind === "question") {
      logger.info(
        `[PermissionManager] Poll is on screen, not registering permission: id=${request.id}`,
      );
      return "question_active";
    }

    let state = this.stateOf(scope);
    if (!state) {
      state = createEmptyState();
      this.interactionManager.start(
        {
          kind: "permission",
          expectedInput: "callback",
          payload: state,
        },
        scope,
      );
    }

    const previous = state.requestsByMessageId.get(messageId);
    if (previous) {
      logger.warn(`[PermissionManager] Message ID already tracked, replacing: ${messageId}`);
      // Drop the replaced request's signature so it cannot later group new
      // requests behind a message that now shows something else.
      state.messageIdBySignature.delete(this.getRequestSignature(previous));
      state.sendsByMessageId.delete(messageId);
    }

    state.requestsByMessageId.set(messageId, request);
    state.requestIdsByMessageId.set(messageId, [request.id]);
    state.messageIdBySignature.set(this.getRequestSignature(request), messageId);

    logger.info(
      `[PermissionManager] New permission request: type=${request.permission}, patterns=${request.patterns.join(", ")}, pending=${state.requestsByMessageId.size}`,
    );

    return "started";
  }

  /**
   * Attach an equivalent OpenCode request to an already visible Telegram permission message.
   */
  addEquivalentRequest(
    request: PermissionRequest,
    generation?: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): GroupedPermissionMessage | null {
    if (this.getDropReason(request, generation, scope)) {
      logger.debug(
        `[PermissionManager] Ignoring stale or already resolved equivalent request: id=${request.id}`,
      );
      return null;
    }

    const state = this.stateOf(scope);
    if (!state) {
      return null;
    }

    const signature = this.getRequestSignature(request);
    const messageId = state.messageIdBySignature.get(signature);
    if (messageId === undefined || state.sendsByMessageId.has(messageId)) {
      // A prompt whose answer is on its way cannot take a request that answer does not cover.
      return null;
    }

    const visibleRequest = state.requestsByMessageId.get(messageId);
    if (!visibleRequest) {
      logger.warn(
        `[PermissionManager] Dropping orphan permission signature: messageId=${messageId}`,
      );
      state.messageIdBySignature.delete(signature);
      return null;
    }

    const requestIds = state.requestIdsByMessageId.get(messageId) ?? [];
    if (!requestIds.includes(request.id)) {
      requestIds.push(request.id);
      state.requestIdsByMessageId.set(messageId, requestIds);
    }

    logger.info(
      `[PermissionManager] Merged equivalent permission request: id=${request.id}, messageId=${messageId}, grouped=${requestIds.length}`,
    );

    return { messageId, request: visibleRequest, count: requestIds.length };
  }

  /**
   * Get permission request by Telegram message ID
   */
  getRequest(
    messageId: number | null,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): PermissionRequest | null {
    if (messageId === null) {
      return null;
    }

    return this.stateOf(scope)?.requestsByMessageId.get(messageId) ?? null;
  }

  /**
   * Get request ID for API reply by Telegram message ID
   */
  getRequestID(
    messageId: number | null,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): string | null {
    return this.getRequest(messageId, scope)?.id ?? null;
  }

  /**
   * Get all OpenCode request IDs grouped behind a Telegram message.
   */
  getRequestIDs(messageId: number | null, scope: string = DEFAULT_INTERACTION_SCOPE): string[] {
    if (messageId === null) {
      return [];
    }

    return [...(this.stateOf(scope)?.requestIdsByMessageId.get(messageId) ?? [])];
  }

  /**
   * Get permission type (bash, edit, etc.) by message ID
   */
  getPermissionType(
    messageId: number | null,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): string | null {
    return this.getRequest(messageId, scope)?.permission ?? null;
  }

  /**
   * Get patterns (commands/files) by message ID
   */
  getPatterns(messageId: number | null, scope: string = DEFAULT_INTERACTION_SCOPE): string[] {
    return this.getRequest(messageId, scope)?.patterns ?? [];
  }

  /**
   * Check if callback message ID belongs to active permission request
   */
  isActiveMessage(messageId: number | null, scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return messageId !== null && (this.stateOf(scope)?.requestsByMessageId.has(messageId) ?? false);
  }

  /**
   * Get latest Telegram message ID
   */
  getMessageId(scope: string = DEFAULT_INTERACTION_SCOPE): number | null {
    const messageIds = this.getMessageIds(scope);
    if (messageIds.length === 0) {
      return null;
    }

    return messageIds[messageIds.length - 1] ?? null;
  }

  /**
   * Get Telegram message IDs for all active requests
   */
  getMessageIds(scope: string = DEFAULT_INTERACTION_SCOPE): number[] {
    return Array.from(this.stateOf(scope)?.requestsByMessageId.keys() ?? []);
  }

  /**
   * Record the answer tapped on a prompt as being sent. False when one is already on its way.
   */
  markSending(
    messageId: number,
    reply: PermissionReply,
    settlesSession: boolean,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): boolean {
    const state = this.stateOf(scope);
    const requestIds = state?.requestIdsByMessageId.get(messageId);
    if (!state || !requestIds || state.sendsByMessageId.has(messageId)) {
      return false;
    }

    state.sendsByMessageId.set(messageId, { reply, requestIds: [...requestIds], settlesSession });
    return true;
  }

  isSending(messageId: number | null, scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return messageId !== null && (this.stateOf(scope)?.sendsByMessageId.has(messageId) ?? false);
  }

  /**
   * The answer did not get through for every request: the ones OpenCode took leave the
   * prompt, the rest stay open and answerable again
   */
  failSending(
    messageId: number,
    acceptedRequestIds: string[],
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): PermissionPromptChange | null {
    const state = this.stateOf(scope);
    const request = state?.requestsByMessageId.get(messageId);
    const send = state?.sendsByMessageId.get(messageId);
    if (!state || !request || !send) {
      return null;
    }

    state.sendsByMessageId.delete(messageId);
    for (const requestID of acceptedRequestIds) {
      this.getResolvedRequestIDs().add(requestID);
    }

    const openIds = (state.requestIdsByMessageId.get(messageId) ?? []).filter(
      (requestID) => !acceptedRequestIds.includes(requestID),
    );
    if (openIds.length === 0) {
      // The requests that failed were settled by OpenCode's own events meanwhile.
      return this.endPrompt(
        messageId,
        { kind: "replied", reply: send.reply, outside: false },
        scope,
      );
    }

    state.requestIdsByMessageId.set(messageId, openIds);
    return { messageId, request, openCount: openIds.length, outcome: null };
  }

  /**
   * End a prompt with an outcome, settling every request it still has open
   */
  endPrompt(
    messageId: number,
    outcome: PermissionOutcome,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): PermissionPromptChange | null {
    const state = this.stateOf(scope);
    const request = state?.requestsByMessageId.get(messageId);
    if (!state || !request) {
      return null;
    }

    for (const requestID of state.requestIdsByMessageId.get(messageId) ?? []) {
      this.getResolvedRequestIDs().add(requestID);
      this.interactionManager.dropWaitingPermission(requestID);
    }

    this.removePrompt(state, messageId, request);
    logger.debug(
      `[PermissionManager] Ended permission prompt: messageId=${messageId}, outcome=${outcome.kind}, pending=${state.requestsByMessageId.size}`,
    );
    return { messageId, request, openCount: 0, outcome };
  }

  /**
   * An OpenCode request was settled: it leaves its prompt, and the prompt ends once its
   * last request is settled. `reply` is the decision OpenCode reported, when it did;
   * `lost` says the request went with a server that stopped, so nobody answered it.
   */
  settleRequest(
    requestID: string,
    reply: PermissionReply | null,
    lost = false,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): PermissionPromptChange[] {
    this.getResolvedRequestIDs().add(requestID);
    this.interactionManager.dropWaitingPermission(requestID);

    const state = this.stateOf(scope);
    if (!state) {
      return [];
    }

    const changes: PermissionPromptChange[] = [];
    for (const [messageId, request] of [...state.requestsByMessageId]) {
      const requestIds = state.requestIdsByMessageId.get(messageId) ?? [];
      if (!requestIds.includes(requestID)) {
        continue;
      }

      const openIds = requestIds.filter((id) => id !== requestID);
      if (openIds.length > 0) {
        state.requestIdsByMessageId.set(messageId, openIds);
        // A prompt mid-send keeps its look until the answer lands.
        if (!state.sendsByMessageId.has(messageId)) {
          changes.push({ messageId, request, openCount: openIds.length, outcome: null });
        }
        continue;
      }

      const outcome = this.getSettledOutcome(state, messageId, request, requestID, reply, lost);
      this.removePrompt(state, messageId, request);
      changes.push({ messageId, request, openCount: 0, outcome });
    }

    if (changes.length > 0) {
      logger.debug(
        `[PermissionManager] Settled permission request: id=${requestID}, prompts=${changes.length}, pending=${state.requestsByMessageId.size}`,
      );
    }

    return changes;
  }

  /**
   * End every prompt of a session whose answer is not on its way, and drop its waiting
   * permissions
   */
  endSessionPrompts(
    sessionID: string,
    outcome: PermissionOutcome,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): PermissionPromptChange[] {
    this.interactionManager.dropWaitingPermissionsForSession(sessionID);

    const state = this.stateOf(scope);
    if (!state) {
      return [];
    }

    const messageIds = [...state.requestsByMessageId]
      .filter(
        ([messageId, request]) =>
          request.sessionID === sessionID && !state.sendsByMessageId.has(messageId),
      )
      .map(([messageId]) => messageId);

    return messageIds.flatMap(
      (messageId) => this.endPrompt(messageId, outcome, scope) ?? [],
    );
  }

  /**
   * Open request IDs of the prompts on screen, except prompts whose answer is on its way
   */
  getSettleableRequestIds(scope: string = DEFAULT_INTERACTION_SCOPE): string[] {
    const state = this.stateOf(scope);
    if (!state) {
      return [];
    }

    return [...state.requestIdsByMessageId].flatMap(([messageId, requestIds]) =>
      state.sendsByMessageId.has(messageId) ? [] : requestIds,
    );
  }

  /**
   * Check whether an OpenCode request ID is already shown or grouped behind a message
   */
  hasRequest(requestID: string, scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    for (const requestIds of this.stateOf(scope)?.requestIdsByMessageId.values() ?? []) {
      if (requestIds.includes(requestID)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whose answer settled a prompt: the one being sent from Telegram (on V2 a reject being
   * sent settles its whole session), otherwise an answer given outside Telegram
   */
  private getSettledOutcome(
    state: PermissionState,
    messageId: number,
    request: PermissionRequest,
    requestID: string,
    reply: PermissionReply | null,
    lost: boolean,
  ): PermissionOutcome {
    const send = state.sendsByMessageId.get(messageId);
    if (send?.requestIds.includes(requestID)) {
      return { kind: "replied", reply: send.reply, outside: false };
    }

    for (const [sendingMessageId, sending] of state.sendsByMessageId) {
      const sendingRequest = state.requestsByMessageId.get(sendingMessageId);
      if (sending.settlesSession && sendingRequest?.sessionID === request.sessionID) {
        return { kind: "replied", reply: "reject", outside: false };
      }
    }

    if (lost) {
      return { kind: "not_answered" };
    }

    return reply ? { kind: "replied", reply, outside: true } : { kind: "settled_outside" };
  }

  private removePrompt(state: PermissionState, messageId: number, request: PermissionRequest): void {
    state.requestsByMessageId.delete(messageId);
    state.requestIdsByMessageId.delete(messageId);
    state.sendsByMessageId.delete(messageId);

    // A newer prompt may own the signature now; only this prompt's entry goes.
    const signature = this.getRequestSignature(request);
    if (state.messageIdBySignature.get(signature) === messageId) {
      state.messageIdBySignature.delete(signature);
    }
  }

  isResolved(requestID: string): boolean {
    return this.getResolvedRequestIDs().has(requestID);
  }

  getGeneration(scope: string = DEFAULT_INTERACTION_SCOPE): number {
    return this.interactionManager.getGeneration(scope);
  }

  /**
   * Get number of active permission requests
   */
  getPendingCount(scope: string = DEFAULT_INTERACTION_SCOPE): number {
    return this.stateOf(scope)?.requestsByMessageId.size ?? 0;
  }

  /**
   * Check if there are active permission requests
   */
  isActive(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.getPendingCount(scope) > 0;
  }

  /**
   * Drop every permission prompt and mark prompts still being sent as stale
   */
  clear(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    logger.debug(
      `[PermissionManager] Clearing permission state: scope=${scope}, pending=${this.getPendingCount(scope)}`,
    );

    // Bump first, so a poll released by this clear carries the new generation of
    // its own scope, and no await of another scope is invalidated.
    this.interactionManager.bumpGeneration(scope);
    this.interactionManager.clearKind("permission", "permission_cleared", scope);
  }
}
