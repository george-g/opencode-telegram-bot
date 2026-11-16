import type {
  ActiveInteraction,
  DroppedPermissionPromptsListener,
  DroppedQuestionListener,
  InteractionClearReason,
  InteractionPayloads,
  InteractionResetListener,
  InteractionState,
  StartInteractionOptions,
  StatefulInteractionKind,
  TransitionInteractionOptions,
  WaitingAgentRequest,
  WaitingAgentRequestListener,
} from "../types/interaction.js";
import type { PermissionRequest } from "../types/permission.js";
import type { Question } from "../types/question.js";
import type { QuestionState } from "../types/question.js";
import { logger } from "../../utils/logger.js";
import { DEFAULT_INTERACTION_SCOPE } from "../types/interaction-scope.js";

export { DEFAULT_INTERACTION_SCOPE } from "../types/interaction-scope.js";

export const DEFAULT_ALLOWED_INTERACTION_COMMANDS = [
  "/help",
  "/status",
  "/abort",
  "/detach",
  "/opencode_stop",
] as const;

function normalizeCommand(command: string): string | null {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutMention = withSlash.split("@")[0];
  if (!withoutMention || withoutMention.length <= 1) {
    return null;
  }

  return withoutMention;
}

function normalizeAllowedCommands(commands?: string[]): string[] {
  if (commands === undefined) {
    return [...DEFAULT_ALLOWED_INTERACTION_COMMANDS];
  }

  const normalized = new Set<string>();

  for (const command of commands) {
    const value = normalizeCommand(command);
    if (value) {
      normalized.add(value);
    }
  }

  return Array.from(normalized);
}

function toSnapshot(state: ActiveInteraction): InteractionState {
  return {
    kind: state.kind,
    expectedInput: state.expectedInput,
    allowedCommands: [...state.allowedCommands],
    metadata: { ...state.metadata },
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
  };
}

function isAgentRequestKind(kind: InteractionState["kind"]): boolean {
  return kind === "question" || kind === "permission";
}

export type InteractionErrorScope =
  | "question"
  | "permission"
  | "rename"
  | "taskCreation"
  | "interaction"
  | "none";

const SCOPE_TO_INTERACTION_KIND: Record<
  Exclude<InteractionErrorScope, "interaction" | "none">,
  StatefulInteractionKind
> = {
  question: "question",
  permission: "permission",
  rename: "rename",
  taskCreation: "task",
};

/**
 * One interaction slot per scope. A scope is one chat plus its forum topic, keyed
 * by `interactionScopeKey`. A menu or a prompt opened in one topic holds only
 * that topic's slot, so it never blocks input in another topic or in General.
 *
 * `waiting` is per scope too: a request is queued only because the slot of its
 * own scope was busy, so only that scope's clear can release it.
 *
 * The epoch is per scope: `globalEpoch` counts full resets, `scopeEpochs` counts
 * the resets and clears of one scope. A scope's epoch is their sum, so a scope
 * local clear invalidates only its own awaits, and a full reset invalidates every
 * await, including the waits of a scope that holds no state yet.
 */
export class InteractionManager {
  private slots = new Map<string, ActiveInteraction>();
  // Agent requests waiting for the slot of their scope, in the order they arrived.
  private waiting = new Map<string, WaitingAgentRequest[]>();
  // Full resets. Every scope's epoch follows this counter.
  private globalEpoch = 0;
  // Resets and clears of one scope.
  private scopeEpochs = new Map<string, number>();
  private onWaitingRequestReady: WaitingAgentRequestListener | null = null;
  private onPermissionPromptsDropped: DroppedPermissionPromptsListener | null = null;
  private onQuestionDropped: DroppedQuestionListener | null = null;
  private onReset: InteractionResetListener | null = null;
  // Request IDs taken out of the queue whose presentation has not finished yet.
  private releasingRequestIds = new Set<string>();

  /**
   * Opens the slot of the scope, replacing whatever it held. Replacing never
   * releases the waiting request: only a clear does.
   */
  start(
    options: StartInteractionOptions,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): InteractionState {
    const now = Date.now();
    let expiresAt: number | null = null;

    if (this.slots.has(scope)) {
      this.drop("state_replaced", scope);
    }

    const { expiresInMs, ...rest } = options;
    if (typeof expiresInMs === "number") {
      expiresAt = now + expiresInMs;
    }

    const nextState: ActiveInteraction = {
      ...rest,
      allowedCommands: normalizeAllowedCommands(options.allowedCommands),
      metadata: options.metadata ? { ...options.metadata } : {},
      createdAt: now,
      expiresAt,
    };

    this.slots.set(scope, nextState);

    logger.info(
      `[InteractionManager] Started interaction: scope=${scope}, kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return toSnapshot(nextState);
  }

  get(scope: string = DEFAULT_INTERACTION_SCOPE): InteractionState | null {
    const state = this.slots.get(scope);
    if (!state) {
      return null;
    }

    return toSnapshot(state);
  }

  getSnapshot(scope: string = DEFAULT_INTERACTION_SCOPE): InteractionState | null {
    return this.get(scope);
  }

  /**
   * Live data of the given kind in the scope, or null when the slot holds
   * another kind.
   */
  getPayload<K extends StatefulInteractionKind>(
    kind: K,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): InteractionPayloads[K] | null {
    const state = this.slots.get(scope);
    if (!state || state.kind !== kind || !("payload" in state)) {
      return null;
    }

    return state.payload as InteractionPayloads[K];
  }

  isActive(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.slots.has(scope);
  }

  isExpired(
    referenceTimeMs: number = Date.now(),
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): boolean {
    const state = this.slots.get(scope);
    if (!state || state.expiresAt === null) {
      return false;
    }

    return referenceTimeMs >= state.expiresAt;
  }

  transition(
    options: TransitionInteractionOptions,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): InteractionState | null {
    const state = this.slots.get(scope);
    if (!state) {
      return null;
    }

    const now = Date.now();

    const nextState: ActiveInteraction = {
      ...state,
      expectedInput: options.expectedInput ?? state.expectedInput,
      allowedCommands:
        options.allowedCommands !== undefined
          ? normalizeAllowedCommands(options.allowedCommands)
          : [...state.allowedCommands],
      metadata: options.metadata ? { ...options.metadata } : { ...state.metadata },
      expiresAt:
        options.expiresInMs === undefined
          ? state.expiresAt
          : options.expiresInMs === null
            ? null
            : now + options.expiresInMs,
    } as ActiveInteraction;

    this.slots.set(scope, nextState);

    logger.debug(
      `[InteractionManager] Transitioned interaction: scope=${scope}, kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return toSnapshot(nextState);
  }

  /**
   * Empties the slot of the scope. When a question or permission ends and an agent
   * request of that scope waits, the one that arrived first is handed to the listener.
   */
  clear(reason: InteractionClearReason = "manual", scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const clearedKind = this.drop(reason, scope);
    if (!clearedKind || !isAgentRequestKind(clearedKind)) {
      return;
    }

    this.releaseHead(clearedKind, scope);
  }

  /**
   * Hands the first waiting request of the scope to the listener while that scope's
   * slot is empty, so a released request that was not shown does not leave the rest
   * waiting.
   */
  releaseNext(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    if (this.slots.has(scope)) {
      return;
    }

    this.releaseHead("empty_slot", scope);
  }

  /**
   * Clears the slot of the scope only if it holds the given kind.
   */
  clearKind(
    kind: InteractionState["kind"],
    reason: InteractionClearReason,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    if (this.slots.get(scope)?.kind === kind) {
      this.clear(reason, scope);
    }
  }

  /**
   * Drops every slot and every waiting request, and marks permission prompts still
   * being sent as stale. With a scope, only that scope is dropped. A reset without
   * a scope moves the epoch of every scope; one scope's reset moves only its own.
   */
  reset(reason: InteractionClearReason, scope?: string): void {
    const scopes =
      scope === undefined
        ? [...new Set([...this.slots.keys(), ...this.waiting.keys()])]
        : [scope];

    let interactionKind: string | null = null;
    let waitingCount = 0;

    // A full reset moves every epoch, a scoped one only its own. The full counter
    // covers the scopes that hold no state yet.
    if (scope === undefined) {
      this.globalEpoch++;
    } else {
      this.bumpGeneration(scope);
    }

    for (const current of scopes) {
      const dropped = this.slots.get(current)?.kind ?? null;
      if (dropped !== null) {
        interactionKind =
          interactionKind === null || interactionKind === dropped ? dropped : "multiple";
      }

      waitingCount += this.waiting.get(current)?.length ?? 0;
      this.waiting.delete(current);
      this.dropAndEndPoll(() => this.drop(reason, current), current);
    }

    try {
      this.onReset?.();
    } catch (err) {
      logger.error("[InteractionManager] Error in reset listener:", err);
    }

    const message =
      `[InteractionCleanup] Cleared state: reason=${reason}, ` +
      `interactionKind=${interactionKind ?? "none"}, waiting=${waitingCount}`;

    if (interactionKind !== null || waitingCount > 0) {
      logger.info(message);
      return;
    }

    logger.debug(message);
  }

  /**
   * Drops only what a failed handler in the given scope may have left behind. The
   * error scope names the interaction kind; `slotScope` names the chat and topic.
   */
  clearErrorScope(
    scope: InteractionErrorScope,
    reason: InteractionClearReason,
    slotScope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    if (scope === "none") {
      return;
    }

    const stateBefore = this.getSnapshot(slotScope);

    if (scope === "interaction") {
      this.dropAndEndPoll(() => this.clear(reason, slotScope), slotScope);
    } else {
      if (scope === "permission") {
        // Bump the scope first, so a poll released by this clear carries the new
        // epoch of its own scope, and no other scope's await is invalidated.
        this.bumpGeneration(slotScope);
      }

      this.dropAndEndPoll(
        () => this.clearKind(SCOPE_TO_INTERACTION_KIND[scope], reason, slotScope),
        slotScope,
      );
    }

    logger.debug(
      `[InteractionCleanup] Cleared scoped state: reason=${reason}, scope=${scope}, interactionKind=${stateBefore?.kind || "none"}`,
    );
  }

  getGeneration(scope: string = DEFAULT_INTERACTION_SCOPE): number {
    return this.globalEpoch + (this.scopeEpochs.get(scope) ?? 0);
  }

  /**
   * The epoch of full resets alone. The permission manager's resolved-request set
   * is process-wide, so only a full reset forgets it.
   */
  getResetEpoch(): number {
    return this.globalEpoch;
  }

  bumpGeneration(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    this.scopeEpochs.set(scope, (this.scopeEpochs.get(scope) ?? 0) + 1);
  }

  /**
   * Queues a poll in its scope. A poll of a session that already waits replaces that
   * one in its place; `atHead` puts a released poll that has to wait again back in
   * front.
   */
  waitQuestion(
    questions: Question[],
    requestID: string,
    sessionId: string,
    options: { atHead?: boolean } = {},
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    const entry: WaitingAgentRequest = { kind: "question", questions, requestID, sessionId };
    const queue = this.waitingQueue(scope);
    const index = queue.findIndex(
      (waiting) => waiting.kind === "question" && waiting.sessionId === sessionId,
    );

    if (index >= 0) {
      logger.info(
        `[InteractionManager] Replacing waiting poll of session: session=${sessionId}, scope=${scope}`,
      );
      queue[index] = entry;
    } else if (options.atHead) {
      queue.unshift(entry);
    } else {
      queue.push(entry);
    }

    logger.info(
      `[InteractionManager] Poll is waiting: requestID=${requestID}, scope=${scope}, waiting=${queue.length}`,
    );
  }

  /**
   * Queues a permission in its scope. It joins the permission group at the end of the
   * queue (or at its head with `atHead`), or starts a new group when a poll waits in
   * that place.
   */
  waitPermission(
    request: PermissionRequest,
    options: { atHead?: boolean } = {},
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    if (this.isWaitingPermission(request.id)) {
      return;
    }

    const queue = this.waitingQueue(scope);
    const index = options.atHead ? 0 : queue.length - 1;
    const neighbour = queue[index];
    if (neighbour?.kind === "permission") {
      neighbour.requests.push(request);
    } else if (options.atHead) {
      queue.unshift({ kind: "permission", requests: [request] });
    } else {
      queue.push({ kind: "permission", requests: [request] });
    }

    logger.info(
      `[InteractionManager] Permission is waiting: requestID=${request.id}, scope=${scope}, waiting=${queue.length}`,
    );
  }

  dropWaitingPermission(requestID: string): void {
    if (this.dropWaitingPermissions((request) => request.id === requestID)) {
      logger.info(`[InteractionManager] Dropped waiting permission: requestID=${requestID}`);
    }
  }

  dropWaitingPermissionsForSession(sessionID: string): void {
    if (this.dropWaitingPermissions((request) => request.sessionID === sessionID)) {
      logger.info(
        `[InteractionManager] Dropped waiting permissions of session: session=${sessionID}`,
      );
    }
  }

  dropWaitingQuestion(requestID: string): boolean {
    return this.dropWaitingQuestions((waiting) => waiting.requestID === requestID);
  }

  dropWaitingQuestionsForSession(sessionId: string): boolean {
    return this.dropWaitingQuestions((waiting) => waiting.sessionId === sessionId);
  }

  /** Kind of the request that is released next anywhere, or null when nothing waits. */
  getWaitingKind(): WaitingAgentRequest["kind"] | null {
    for (const queue of this.waiting.values()) {
      const head = queue[0];
      if (head) {
        return head.kind;
      }
    }

    return null;
  }

  isWaitingQuestion(requestID: string): boolean {
    return this.getWaitingQuestionRequestIds().includes(requestID);
  }

  isWaitingPermission(requestID: string): boolean {
    return this.getWaitingPermissionRequestIds().includes(requestID);
  }

  /** Whether a request waits in any queue or was released and is still being presented. */
  isWaitingOrReleasing(requestID: string): boolean {
    return (
      this.releasingRequestIds.has(requestID) ||
      this.isWaitingQuestion(requestID) ||
      this.isWaitingPermission(requestID)
    );
  }

  getWaitingQuestionRequestIds(): string[] {
    return [...this.waiting.values()].flatMap((queue) =>
      queue.flatMap((waiting) => (waiting.kind === "question" ? [waiting.requestID] : [])),
    );
  }

  getWaitingPermissionRequestIds(): string[] {
    return [...this.waiting.values()].flatMap((queue) =>
      queue.flatMap((waiting) =>
        waiting.kind === "permission" ? waiting.requests.map((request) => request.id) : [],
      ),
    );
  }

  setOnWaitingRequestReady(listener: WaitingAgentRequestListener | null): void {
    this.onWaitingRequestReady = listener;
  }

  setOnPermissionPromptsDropped(listener: DroppedPermissionPromptsListener | null): void {
    this.onPermissionPromptsDropped = listener;
  }

  setOnQuestionDropped(listener: DroppedQuestionListener | null): void {
    this.onQuestionDropped = listener;
  }

  setOnReset(listener: InteractionResetListener | null): void {
    this.onReset = listener;
  }

  /** The queue of one scope, created on first use. */
  private waitingQueue(scope: string): WaitingAgentRequest[] {
    let queue = this.waiting.get(scope);
    if (!queue) {
      queue = [];
      this.waiting.set(scope, queue);
    }

    return queue;
  }

  private questionState(scope: string): QuestionState | null {
    const state = this.slots.get(scope);
    return state?.kind === "question" ? state.payload : null;
  }

  /**
   * Runs a cleanup drop and hands a poll it removed to the listener, so the poll gets its
   * "not answered" ending instead of dead buttons. Explicit closes of a poll write their own
   * ending and do not come through here.
   */
  private dropAndEndPoll(dropSlot: () => void, scope: string): void {
    const poll = this.questionState(scope);
    dropSlot();
    if (!poll || this.questionState(scope) === poll) {
      return;
    }

    try {
      this.onQuestionDropped?.(poll);
    } catch (err) {
      logger.error("[InteractionManager] Error in dropped poll listener:", err);
    }
  }

  private releaseHead(after: string, scope: string): void {
    const queue = this.waiting.get(scope);
    const request = queue?.shift();
    if (!request) {
      this.waiting.delete(scope);
      return;
    }

    if (queue && queue.length === 0) {
      this.waiting.delete(scope);
    }

    const generation = this.getGeneration(scope);
    const listener = this.onWaitingRequestReady;
    if (!listener) {
      logger.warn(
        `[InteractionManager] No listener for the waiting request, dropping it: kind=${request.kind}`,
      );
      return;
    }

    logger.info(
      `[InteractionManager] Releasing waiting request: kind=${request.kind}, after=${after}, scope=${scope}, waiting=${queue?.length ?? 0}`,
    );

    const requestIds =
      request.kind === "question" ? [request.requestID] : request.requests.map(({ id }) => id);
    for (const requestID of requestIds) {
      this.releasingRequestIds.add(requestID);
    }

    setImmediate(() => {
      void Promise.resolve()
        .then(() => listener(request, generation))
        .catch((err) => {
          logger.error(`[InteractionManager] Failed to present the waiting ${request.kind}:`, err);
        })
        .finally(() => {
          for (const requestID of requestIds) {
            this.releasingRequestIds.delete(requestID);
          }
          // A released request that was not shown must not hold back the rest of the queue.
          this.releaseNext(scope);
        });
    });
  }

  private dropWaitingPermissions(matches: (request: PermissionRequest) => boolean): boolean {
    let dropped = false;
    for (const [scope, queue] of this.waiting) {
      const next = queue.flatMap((waiting): WaitingAgentRequest[] => {
        if (waiting.kind !== "permission") {
          return [waiting];
        }

        const requests = waiting.requests.filter((request) => !matches(request));
        dropped ||= requests.length !== waiting.requests.length;
        return requests.length > 0 ? [{ kind: "permission", requests }] : [];
      });

      if (next.length === 0) {
        this.waiting.delete(scope);
      } else if (next.length !== queue.length || next.some((entry, index) => entry !== queue[index])) {
        this.waiting.set(scope, next);
      }
    }

    return dropped;
  }

  private dropWaitingQuestions(
    matches: (waiting: Extract<WaitingAgentRequest, { kind: "question" }>) => boolean,
  ): boolean {
    let dropped = false;
    for (const [scope, queue] of this.waiting) {
      const next = queue.filter((waiting) => {
        if (waiting.kind !== "question" || !matches(waiting)) {
          return true;
        }

        logger.info(`[InteractionManager] Dropped waiting poll: requestID=${waiting.requestID}`);
        dropped = true;
        return false;
      });

      if (next.length === 0) {
        this.waiting.delete(scope);
      } else if (next.length !== queue.length) {
        this.waiting.set(scope, next);
      }
    }

    return dropped;
  }

  private drop(reason: InteractionClearReason, scope: string): InteractionState["kind"] | null {
    const state = this.slots.get(scope);
    if (!state) {
      return null;
    }

    const dropped = state;
    logger.info(
      `[InteractionManager] Cleared interaction: reason=${reason}, scope=${scope}, kind=${dropped.kind}, expectedInput=${dropped.expectedInput}`,
    );

    this.slots.delete(scope);

    // Prompts still on screen get their "not answered" ending instead of dead buttons.
    if (dropped.kind === "permission" && dropped.payload.requestsByMessageId.size > 0) {
      try {
        this.onPermissionPromptsDropped?.(dropped.payload);
      } catch (err) {
        logger.error("[InteractionManager] Error in dropped permission prompts listener:", err);
      }
    }

    return dropped.kind;
  }
}
