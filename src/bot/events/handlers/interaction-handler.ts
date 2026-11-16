import { getDeleteCompactProgressOnFinish } from "../../../app/stores/settings-store.js";
import { logger } from "../../../utils/logger.js";
import type { PermissionRequest } from "../../../app/types/permission.js";
import type { Question } from "../../../app/types/question.js";
import { interactionScopeFromDestination } from "../../../app/types/interaction-scope.js";
import {
  closeDroppedPoll,
  closeQuestionCancelled,
  closeQuestionSettledOutside,
  showCurrentQuestion,
} from "../../menus/question-menu.js";
import {
  applyPermissionPromptChanges,
  showPermissionRequest,
  syncPermissionInteractionState,
} from "../../menus/permission-menu.js";
import { keepAssistantDraftsBeforePrompt } from "./assistant-response-handler.js";
import { isCompactProgressMode, type EventHandlerDeps } from "./handler-context.js";

type InteractionDeps = EventHandlerDeps<
  | "assistantRunState"
  | "interactionManager"
  | "keyboardManager"
  | "permissionManager"
  | "questionManager"
  | "summaryAggregator"
>;

/** The session the chat follows for a request: a subagent's requests belong to its root. */
function getFollowedSessionId(deps: InteractionDeps, sessionId: string): string {
  const { summaryAggregator } = deps;
  return summaryAggregator.isSubagentSession(sessionId)
    ? summaryAggregator.getRootSessionId(sessionId)
    : sessionId;
}

/**
 * Shows a poll, or leaves it waiting while permission prompts or another session's poll
 * are on screen. A subagent's poll is shown while its parent session is followed.
 * `generation` is set for a poll released from the waiting queue.
 */
async function presentQuestion(
  deps: InteractionDeps,
  questions: Question[],
  requestID: string,
  sessionId: string,
  generation: number | null,
): Promise<void> {
  const { questionManager } = deps;
  const destination = deps.policy.getDestination(sessionId);
  if (!destination) {
    logger.error("Bot or chat ID not available for showing questions");
    return;
  }

  if (!deps.policy.isForegroundSession(getFollowedSessionId(deps, sessionId))) {
    return;
  }

  const scope = interactionScopeFromDestination(destination);

  // While the messages before the poll go out, a settle, reset or run end of its question
  // is recorded for it, so the poll is not shown for a question that is gone.
  questionManager.trackInFlight(requestID, sessionId);
  try {
    await showOrQueueQuestion(deps, questions, requestID, sessionId, generation, scope);
  } finally {
    questionManager.untrackInFlight(requestID);
  }
}

async function showOrQueueQuestion(
  deps: InteractionDeps,
  questions: Question[],
  requestID: string,
  sessionId: string,
  generation: number | null,
  scope: string,
): Promise<void> {
  const { runtime, policy, interactionManager, questionManager } = deps;
  const destination = policy.getDestination(sessionId);
  if (!destination) {
    return;
  }

  const followedSessionId = getFollowedSessionId(deps, sessionId);

  await Promise.all([
    runtime.toolMessageBatcher.flushSession(sessionId, "question_asked"),
    runtime.toolCallStreamer.flushSession(sessionId, "question_asked"),
    runtime.todoSnapshots.flush(sessionId),
  ]);
  await keepAssistantDraftsBeforePrompt(deps, followedSessionId);
  await runtime.letOutReplies(followedSessionId);

  // Decide and open the slot in one synchronous step: a permission or a
  // reset may have landed during the flushes. The epoch is that of this scope.
  if (generation !== null && generation !== interactionManager.getGeneration(scope)) {
    logger.info(`[Bot] Dropping waiting poll after a reset: requestID=${requestID}`);
    return;
  }

  const ending = questionManager.getInFlightEnding(requestID);
  if (ending) {
    logger.info(`[Bot] Dropping poll whose question ended before it was shown: requestID=${requestID}, ending=${ending}`);
    return;
  }

  if (!policy.isForegroundSession(followedSessionId)) {
    return;
  }

  const replacing =
    questionManager.isActive(scope) && questionManager.getSessionId(scope) === sessionId;
  const previousMessageIds = replacing ? questionManager.getMessageIds(scope) : [];
  const previousRequestID = replacing ? questionManager.getRequestID(scope) : null;
  if (!questionManager.startQuestions(questions, requestID, sessionId, scope)) {
    // A released poll that has to wait again keeps its turn at the head of the queue.
    interactionManager.waitQuestion(
      questions,
      requestID,
      sessionId,
      { atHead: generation !== null },
      scope,
    );
    return;
  }

  if (isCompactProgressMode()) {
    await runtime.compactProgressStreamer.flushPending(followedSessionId);
    runtime.compactProgressStreamer.holdForClose(followedSessionId);
  }

  if (previousRequestID && previousRequestID !== requestID) {
    // A replaced poll whose message is still on its way is deleted when it lands.
    questionManager.endInFlight(previousRequestID, "replaced");
  }

  if (previousMessageIds.length > 0) {
    logger.warn("[Bot] Replacing active poll with a new one");
    for (const messageId of previousMessageIds) {
      await destination.api.deleteMessage(destination.chatId, messageId).catch(() => {});
    }
  }

  logger.info(
    `[Bot] Received ${questions.length} questions from agent, requestID=${requestID}, subagent=${followedSessionId !== sessionId}`,
  );
  try {
    await showCurrentQuestion(destination.api, destination.chatId, deps, scope);
  } catch {
    runtime.compactProgressStreamer.releaseHold(followedSessionId);
    return;
  }

  if (isCompactProgressMode()) {
    await runtime.compactProgressStreamer.finalize(
      followedSessionId,
      getDeleteCompactProgressOnFinish(),
    );
  } else {
    runtime.compactProgressStreamer.releaseHold(followedSessionId);
  }
}

/**
 * Shows a permission prompt, or leaves it waiting while a poll is on screen.
 * A subagent's request is shown while its parent session is followed.
 */
async function presentPermission(
  deps: InteractionDeps,
  request: PermissionRequest,
  generation: number | null,
  released = false,
): Promise<void> {
  const { runtime, policy, interactionManager, permissionManager } = deps;
  const sessionId = request.sessionID;
  const destination = policy.getDestination(sessionId);
  if (!destination) {
    logger.error("Bot or chat ID not available for showing permission request");
    return;
  }

  const scope = interactionScopeFromDestination(destination);
  // A released request carries the epoch of its own scope; a fresh one reads it here.
  const requestGeneration = generation ?? permissionManager.getGeneration(scope);
  const followedSessionId = getFollowedSessionId(deps, sessionId);
  const isSubagent = followedSessionId !== sessionId;
  if (!policy.isForegroundSession(followedSessionId)) {
    return;
  }

  await Promise.all([
    runtime.toolMessageBatcher.flushSession(sessionId, "permission_asked"),
    runtime.toolCallStreamer.flushSession(sessionId, "permission_asked"),
    runtime.todoSnapshots.flush(sessionId),
  ]);
  await keepAssistantDraftsBeforePrompt(deps, followedSessionId);
  await runtime.letOutReplies(followedSessionId);

  // Decide in one synchronous step: a poll or a reset may have landed during the flushes.
  if (permissionManager.getDropReason(request, requestGeneration, scope)) {
    logger.debug(`[Bot] Dropping stale or resolved permission request: requestID=${request.id}`);
    return;
  }

  if (interactionManager.getSnapshot(scope)?.kind === "question") {
    interactionManager.waitPermission(request, { atHead: released }, scope);
    return;
  }

  if (isCompactProgressMode()) {
    await runtime.compactProgressStreamer.flushPending(followedSessionId);
    runtime.compactProgressStreamer.holdForClose(followedSessionId);
  }

  logger.info(
    `[Bot] Received permission request from agent: type=${request.permission}, requestID=${request.id}, subagent=${isSubagent}`,
  );
  const messageIdsBefore = new Set(permissionManager.getMessageIds(scope));
  try {
    await showPermissionRequest(
      destination.api,
      destination.chatId,
      request,
      deps,
      requestGeneration,
      scope,
    );
  } catch {
    runtime.compactProgressStreamer.releaseHold(followedSessionId);
    return;
  }

  const promptLanded = permissionManager
    .getMessageIds(scope)
    .some((messageId) => !messageIdsBefore.has(messageId));
  if (isCompactProgressMode() && promptLanded) {
    await runtime.compactProgressStreamer.finalize(
      followedSessionId,
      getDeleteCompactProgressOnFinish(),
    );
  } else {
    runtime.compactProgressStreamer.releaseHold(followedSessionId);
  }
}

/** Polls and permission prompts, including the queue of waiting requests. */
export function registerInteractionHandlers(deps: InteractionDeps): void {
  const { policy, interactionManager, permissionManager, questionManager, summaryAggregator } =
    deps;

  /**
   * The scope of a session's prompts: its bound topic, or the plain chat. A session
   * with no destination has no scope to queue under, so its request is not queued:
   * a request under a guess would be removed by an unrelated clear.
   */
  const scopeOf = (sessionId: string): string | null => {
    const destination = policy.getDestination(sessionId);
    if (!destination) {
      logger.warn(
        `[Bot] No destination for the session's interaction, dropping it: session=${sessionId}`,
      );
      return null;
    }

    return interactionScopeFromDestination(destination);
  };

  summaryAggregator.setOnQuestion(async (questions, requestID, sessionId) => {
    await presentQuestion(deps, questions, requestID, sessionId, null);
  });

  summaryAggregator.setOnQuestionError(async (sessionId) => {
    questionManager.endInFlightForSession(sessionId, "not_answered");

    const scope = scopeOf(sessionId);
    if (
      scope === null ||
      !questionManager.isActive(scope) ||
      questionManager.getSessionId(scope) !== sessionId
    ) {
      interactionManager.dropWaitingQuestionsForSession(sessionId);
      return;
    }

    // A dismissal or answers sent from Telegram fail or end the tool: the poll is left to them.
    if (questionManager.isSettlingFromTelegram(scope)) {
      return;
    }

    logger.info("[Bot] Question tool failed, clearing active poll and deleting messages");

    const messageIds = questionManager.getMessageIds(scope);
    questionManager.clear(scope);

    const destination = policy.getDestination(sessionId);
    for (const messageId of messageIds) {
      if (destination) {
        await destination.api.deleteMessage(destination.chatId, messageId).catch((err) => {
          logger.error(`[Bot] Failed to delete question message ${messageId}:`, err);
        });
      }
    }
  });

  summaryAggregator.setOnFooterSuppressed((sessionId) => {
    deps.assistantRunState.suppressFooter(sessionId);
  });

  summaryAggregator.setOnQuestionSettled(async (sessionId, requestID, outcome) => {
    // A poll whose message is still on its way ends with this outcome once it lands.
    questionManager.endInFlight(requestID, outcome);

    const scope = scopeOf(sessionId);
    if (
      scope === null ||
      !questionManager.isActive(scope) ||
      questionManager.getRequestID(scope) !== requestID
    ) {
      interactionManager.dropWaitingQuestion(requestID);
      return;
    }

    // The answers or the dismissal are on their way: their result decides how the poll ends.
    if (questionManager.isSettlingFromTelegram(scope)) {
      questionManager.noteSettledWhileSending(outcome, scope);
      return;
    }

    const destination = policy.getDestination(sessionId);
    if (!destination) {
      questionManager.clear(scope);
      return;
    }

    // The Cancel reported as not delivered did get through after all.
    if (outcome === "cancelled" && questionManager.hasLastCancelFailed(scope)) {
      await closeQuestionCancelled(destination.api, destination.chatId, deps, scope);
      return;
    }

    await closeQuestionSettledOutside(destination.api, destination.chatId, outcome, deps, scope);
  });

  summaryAggregator.setOnPermission(async (request) => {
    await presentPermission(deps, request, null);
  });

  interactionManager.setOnWaitingRequestReady(async (request, generation) => {
    if (request.kind === "question") {
      await presentQuestion(
        deps,
        request.questions,
        request.requestID,
        request.sessionId,
        generation,
      );
      return;
    }

    for (const permission of request.requests) {
      await presentPermission(deps, permission, generation, true);
    }
  });

  // A reset ends every poll still on its way to the chat, whatever the slot holds.
  interactionManager.setOnReset(() => {
    questionManager.endAllInFlight("not_answered");
  });

  interactionManager.setOnQuestionDropped((state) => {
    const destination = policy.getDestination(state.sessionId);
    if (destination) {
      void closeDroppedPoll(destination.api, destination.chatId, state);
    }
  });

  interactionManager.setOnPermissionPromptsDropped((state) => {
    const changes = [...state.requestsByMessageId].map(([messageId, request]) => ({
      messageId,
      request,
      openCount: 0,
      outcome: { kind: "not_answered" as const },
    }));
    const destination = policy.getDestination(changes[0]?.request.sessionID ?? "");
    if (!destination) {
      return;
    }

    logger.info(`[Bot] Ending dropped permission prompts as not answered: count=${changes.length}`);
    void applyPermissionPromptChanges(
      destination.api,
      destination.chatId,
      changes,
      deps,
      interactionScopeFromDestination(destination),
    );
  });

  summaryAggregator.setOnPermissionReplied(async (sessionId, requestID, reply) => {
    const scope = scopeOf(sessionId);
    if (scope === null) {
      return;
    }

    const changes = permissionManager.settleRequest(requestID, reply, false, scope);
    if (changes.length === 0) {
      return;
    }

    const destination = policy.getDestination(sessionId);
    if (!destination) {
      syncPermissionInteractionState(deps, {}, scope);
      return;
    }

    await applyPermissionPromptChanges(destination.api, destination.chatId, changes, deps, scope);
    logger.info(
      `[Bot] Settled permission prompt: requestID=${requestID}, prompts=${changes.length}`,
    );
  });

  summaryAggregator.setOnSessionRunEnded(async (sessionId) => {
    interactionManager.dropWaitingQuestionsForSession(sessionId);
    questionManager.endInFlightForSession(sessionId, "not_answered");

    const scope = scopeOf(sessionId);
    if (scope === null) {
      return;
    }

    const changes = permissionManager.endSessionPrompts(sessionId, { kind: "not_answered" }, scope);
    if (changes.length === 0) {
      return;
    }

    const destination = policy.getDestination(sessionId);
    if (!destination) {
      syncPermissionInteractionState(deps, {}, scope);
      return;
    }

    logger.info(
      `[Bot] Session run ended with permission prompts open: session=${sessionId}, prompts=${changes.length}`,
    );
    await applyPermissionPromptChanges(destination.api, destination.chatId, changes, deps, scope);
  });
}
