import type { Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import {
  clearQuestionInteraction,
  closeQuestionCancelled,
  closeQuestionSettledOutside,
  isQuestionRequestGone,
  showCurrentQuestion,
  showNextQuestion,
  showQuestionDeliveryWarning,
  submitPollAnswers,
  syncQuestionInteractionState,
  updateQuestionMessage,
  type QuestionReplyResult,
} from "../menus/question-menu.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { getInteractionScope } from "../middleware/interaction-scope.js";
import { alert } from "./feedback.js";

export type QuestionCallbackDeps = Pick<
  AppContainer,
  "interactionManager" | "questionManager" | "summaryAggregator"
>;

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

/** The poll's last question: answering it sends the whole poll to OpenCode. */
function isLastQuestion(
  deps: QuestionCallbackDeps,
  questionIndex: number,
  scope: string,
): boolean {
  return questionIndex === deps.questionManager.getTotalQuestions(scope) - 1;
}

export async function handleQuestionCallback(
  ctx: Context,
  deps: QuestionCallbackDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  if (!data.startsWith("question:")) {
    return false;
  }

  logger.debug(`[QuestionHandler] Received callback: ${data}`);

  const scope = getInteractionScope(ctx);

  if (!deps.questionManager.isActive(scope)) {
    clearQuestionInteraction("question_inactive_callback", deps, scope);
    await ctx.answerCallbackQuery({ text: t("question.inactive_callback"), show_alert: true });
    return true;
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  if (!deps.questionManager.isActiveMessage(callbackMessageId, scope)) {
    await ctx.answerCallbackQuery({ text: t("question.inactive_callback"), show_alert: true });
    return true;
  }

  if (deps.questionManager.isSettlingFromTelegram(scope)) {
    // The answers or the dismissal are on their way: no button does anything until they land.
    await ctx.answerCallbackQuery();
    return true;
  }

  deps.questionManager.clearLastCancelFailed(scope);

  const parts = data.split(":");
  const action = parts[1];
  const questionIndex = parseInt(parts[2] ?? "", 10);

  if (
    Number.isNaN(questionIndex) ||
    questionIndex !== deps.questionManager.getCurrentIndex(scope)
  ) {
    await ctx.answerCallbackQuery({ text: t("question.inactive_callback"), show_alert: true });
    return true;
  }

  try {
    switch (action) {
      case "select":
        {
          const optionIndex = parseInt(parts[3] ?? "", 10);
          if (Number.isNaN(optionIndex)) {
            await ctx.answerCallbackQuery({
              text: t("question.processing_error_callback"),
              show_alert: true,
            });
            break;
          }

          await handleSelectOption(ctx, deps, scope, questionIndex, optionIndex);
        }
        break;
      case "submit":
        await handleSubmitAnswer(ctx, deps, scope, questionIndex);
        break;
      case "custom":
        await handleCustomAnswer(ctx, deps, scope, questionIndex);
        break;
      case "toggle_custom":
        await handleToggleCustomAnswer(ctx, deps, scope, questionIndex);
        break;
      case "cancel":
        await handleCancelPoll(ctx, deps, scope);
        break;
      default:
        await ctx.answerCallbackQuery({
          text: t("question.processing_error_callback"),
          show_alert: true,
        });
        break;
    }
  } catch (err) {
    logger.error("[QuestionHandler] Error handling callback:", err);
    await ctx.answerCallbackQuery({
      text: t("question.processing_error_callback"),
      show_alert: true,
    });
  }

  return true;
}

async function handleSelectOption(
  ctx: Context,
  deps: QuestionCallbackDeps,
  scope: string,
  questionIndex: number,
  optionIndex: number,
): Promise<void> {
  logger.debug(
    `[QuestionHandler] handleSelectOption: qIndex=${questionIndex}, oIndex=${optionIndex}`,
  );

  const question = deps.questionManager.getCurrentQuestion(scope);
  if (!question) {
    logger.debug("[QuestionHandler] No current question");
    await alert(ctx, "question.inactive_callback");
    return;
  }

  if (deps.questionManager.isWaitingForCustomInput(questionIndex, scope)) {
    deps.questionManager.clearCustomInput(scope);
    syncQuestionInteractionState(
      "callback",
      questionIndex,
      deps.questionManager.getActiveMessageId(scope),
      deps,
      scope,
    );
  }

  deps.questionManager.selectOption(questionIndex, optionIndex, scope);

  if (question.multiple) {
    logger.debug("[QuestionHandler] Multiple choice mode, updating message");
    await updateQuestionMessage(ctx, deps, scope);
    await ctx.answerCallbackQuery();
  } else {
    logger.debug("[QuestionHandler] Single choice mode, moving to next question");
    const requestID = deps.questionManager.getRequestID(scope);
    await ctx.answerCallbackQuery();

    const answer = deps.questionManager.getSelectedAnswer(questionIndex, scope);
    logger.debug(`[QuestionHandler] Selected answer for question ${questionIndex}: ${answer}`);

    await answerStep(ctx, deps, scope, questionIndex, requestID);
  }
}

async function handleSubmitAnswer(
  ctx: Context,
  deps: QuestionCallbackDeps,
  scope: string,
  questionIndex: number,
): Promise<void> {
  if (deps.questionManager.isWaitingForCustomInput(questionIndex, scope)) {
    deps.questionManager.clearCustomInput(scope);
    syncQuestionInteractionState(
      "callback",
      questionIndex,
      deps.questionManager.getActiveMessageId(scope),
      deps,
      scope,
    );
  }

  if (!deps.questionManager.hasAnswer(questionIndex, scope)) {
    await ctx.answerCallbackQuery({
      text: t("question.select_one_required_callback"),
      show_alert: true,
    });
    return;
  }

  logger.debug(
    `[QuestionHandler] Submit answer for question ${questionIndex}: ${deps.questionManager.getAnswerItems(questionIndex, scope).join(" | ")}`,
  );

  const requestID = deps.questionManager.getRequestID(scope);
  await ctx.answerCallbackQuery();
  await answerStep(ctx, deps, scope, questionIndex, requestID);
}

/**
 * A question was answered: the last one sends the poll's answers and stays on screen until
 * OpenCode takes them, an earlier one gives way to the next question. A poll that was closed
 * while the tap was being acknowledged (settled outside Telegram, a reset) is left as it is.
 */
async function answerStep(
  ctx: Context,
  deps: QuestionCallbackDeps,
  scope: string,
  questionIndex: number,
  requestID: string | null,
): Promise<void> {
  if (
    deps.questionManager.getRequestID(scope) !== requestID ||
    !deps.questionManager.isActive(scope)
  ) {
    logger.info(`[QuestionHandler] Poll closed while its tap was handled: requestID=${requestID}`);
    return;
  }

  if (isLastQuestion(deps, questionIndex, scope)) {
    if (ctx.chat) {
      await submitPollAnswers(ctx.api, ctx.chat.id, deps, scope);
    }
    return;
  }

  await ctx.deleteMessage().catch(() => {});
  await showNextQuestion(ctx, deps, scope);
}

async function handleCustomAnswer(
  ctx: Context,
  deps: QuestionCallbackDeps,
  scope: string,
  questionIndex: number,
): Promise<void> {
  deps.questionManager.startCustomInput(questionIndex, scope);
  syncQuestionInteractionState(
    "mixed",
    questionIndex,
    deps.questionManager.getActiveMessageId(scope),
    deps,
    scope,
  );

  await ctx.answerCallbackQuery({
    text: t("question.enter_custom_callback"),
    show_alert: true,
  });
}

async function handleToggleCustomAnswer(
  ctx: Context,
  deps: QuestionCallbackDeps,
  scope: string,
  questionIndex: number,
): Promise<void> {
  if (deps.questionManager.isWaitingForCustomInput(questionIndex, scope)) {
    deps.questionManager.clearCustomInput(scope);
    syncQuestionInteractionState(
      "callback",
      questionIndex,
      deps.questionManager.getActiveMessageId(scope),
      deps,
      scope,
    );
  }

  deps.questionManager.toggleCustomAnswer(questionIndex, scope);

  await updateQuestionMessage(ctx, deps, scope);
  await ctx.answerCallbackQuery();
}

async function handleCancelPoll(
  ctx: Context,
  deps: QuestionCallbackDeps,
  scope: string,
): Promise<void> {
  const { questionManager } = deps;
  const requestID = questionManager.getRequestID(scope);
  const directory = getCurrentSession()?.directory ?? getCurrentProject()?.worktree;
  const chatId = ctx.chat?.id;

  if (!requestID || !directory || chatId === undefined) {
    // Nothing can be sent: the poll stays answerable and says the Cancel did not get through.
    logger.error("[QuestionHandler] No requestID or project for dismissing the question");
    await ctx.answerCallbackQuery();
    if (chatId !== undefined) {
      await showQuestionDeliveryWarning(ctx.api, chatId, deps, scope);
    }
    return;
  }

  questionManager.startDismissal(scope);
  syncQuestionInteractionState(
    "callback",
    questionManager.getCurrentIndex(scope),
    questionManager.getActiveMessageId(scope),
    deps,
    scope,
  );

  // The dismissal is marked as being sent: a lost toast must not keep it from going out.
  await ctx.answerCallbackQuery({ text: t("common.cancelled") }).catch((err) => {
    logger.warn("[QuestionHandler] Failed to answer the cancel callback:", err);
  });

  logger.info(`[QuestionHandler] Dismissing question via question.reject: requestID=${requestID}`);

  safeBackgroundTask({
    taskName: "question.reject",
    task: async (): Promise<QuestionReplyResult> => {
      const { error } = await opencodeClient.question.reject({ requestID, directory });
      if (!error) {
        return "accepted";
      }

      if (isQuestionRequestGone(error)) {
        logger.debug(`[QuestionHandler] Question already settled: requestID=${requestID}`);
        return "gone";
      }

      logger.error(`[QuestionHandler] Failed to dismiss question: requestID=${requestID}`, error);
      return "failed";
    },
    onSuccess: (result) => finishDismissal(ctx.api, chatId, deps, scope, requestID, result),
    onError: () => finishDismissal(ctx.api, chatId, deps, scope, requestID, "failed"),
  });
}

/**
 * Ends the poll once OpenCode answered the dismissal, or leaves it answerable with a
 * warning when the dismissal did not get through. A poll something else already ended
 * stays as it is.
 */
async function finishDismissal(
  api: Context["api"],
  chatId: number,
  deps: QuestionCallbackDeps,
  scope: string,
  requestID: string,
  result: QuestionReplyResult,
): Promise<void> {
  const { questionManager } = deps;
  if (
    !questionManager.isDismissing(scope) ||
    questionManager.getRequestID(scope) !== requestID
  ) {
    logger.info(`[QuestionHandler] Dismissal finished for a poll already closed: ${requestID}`);
    return;
  }

  const settled = questionManager.getSettledWhileSending(scope);
  logger.info(
    `[QuestionHandler] Dismissal finished: requestID=${requestID}, result=${result}, settled=${settled ?? "none"}`,
  );

  if (settled === "answered") {
    await closeQuestionSettledOutside(api, chatId, "answered", deps, scope);
  } else if (result === "gone") {
    await closeQuestionSettledOutside(api, chatId, "cancelled", deps, scope);
  } else if (result === "accepted" || settled === "cancelled") {
    // A lost reply still counts when OpenCode reported the question dismissed.
    await closeQuestionCancelled(api, chatId, deps, scope);
  } else {
    questionManager.failDismissal(scope);
    await showQuestionDeliveryWarning(api, chatId, deps, scope);
  }
}

export async function handleQuestionTextAnswer(
  ctx: Context,
  deps: QuestionCallbackDeps,
): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const scope = getInteractionScope(ctx);
  const currentIndex = deps.questionManager.getCurrentIndex(scope);

  if (!deps.questionManager.isWaitingForCustomInput(currentIndex, scope)) {
    await ctx.reply(t("question.use_custom_button_first"));
    return;
  }

  const multiple = deps.questionManager.getCurrentQuestion(scope)?.multiple ?? false;

  if (!multiple && deps.questionManager.hasCustomAnswer(currentIndex, scope)) {
    await ctx.reply(t("question.answer_already_received"));
    return;
  }

  logger.debug(`[QuestionHandler] Custom text answer for question ${currentIndex}: ${text}`);

  deps.questionManager.setCustomAnswer(currentIndex, text, scope);
  deps.questionManager.clearCustomInput(scope);

  if (!multiple && isLastQuestion(deps, currentIndex, scope)) {
    if (ctx.chat) {
      await submitPollAnswers(ctx.api, ctx.chat.id, deps, scope);
    }
    return;
  }

  const activeMessageId = deps.questionManager.getActiveMessageId(scope);
  if (activeMessageId !== null && ctx.chat) {
    await ctx.api.deleteMessage(ctx.chat.id, activeMessageId).catch(() => {});
  }

  if (multiple) {
    // A multi-select question stays open: re-send it below the user's text with the custom row.
    if (ctx.chat) {
      await showCurrentQuestion(ctx.api, ctx.chat.id, deps, scope);
    }
    return;
  }

  await showNextQuestion(ctx, deps, scope);
}
