import type {
  Question,
  QuestionOption,
  QuestionState,
  QuestionAnswer,
  QuestionSettledOutcome,
  QuestionInFlightEnding,
} from "../types/question.js";
import type { InteractionManager } from "./interaction-manager.js";
import { DEFAULT_INTERACTION_SCOPE } from "../types/interaction-scope.js";
import { logger } from "../../utils/logger.js";

function formatOptionLine(option: QuestionOption): string {
  return `* ${option.label}: ${option.description}`;
}

/** A question whose poll message is not on screen yet, and how it ended meanwhile. */
interface InFlightQuestion {
  sessionId: string;
  ending: QuestionInFlightEnding | null;
}

/**
 * The question poll of one interaction scope. A poll lives in the slot of its own
 * chat and topic, so a poll of one topic never blocks, replaces or reads a poll of
 * another. Every method takes the scope last and defaults to the plain-chat one.
 */
export class QuestionManager {
  // Questions whose poll message is still on its way to the chat.
  private readonly inFlight = new Map<string, InFlightQuestion>();

  constructor(private readonly interactionManager: InteractionManager) {}

  private stateOf(scope: string): QuestionState | null {
    return this.interactionManager.getPayload("question", scope);
  }

  /**
   * Opens the question slot of its scope, replacing a poll of the same session
   * already on screen. Refuses while permission prompts or another session's poll
   * hold that scope's slot: the poll has to wait for them.
   */
  startQuestions(
    questions: Question[],
    requestID: string,
    sessionId: string,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): boolean {
    const current = this.interactionManager.getSnapshot(scope);
    logger.debug(
      `[QuestionManager] startQuestions called: scope=${scope}, slot=${current?.kind ?? "none"}, newQuestions=${questions.length}, requestID=${requestID}`,
    );

    if (current?.kind === "permission") {
      logger.info(
        `[QuestionManager] Permission prompts are on screen, not starting poll: requestID=${requestID}`,
      );
      return false;
    }

    const onScreen = this.stateOf(scope);
    if (onScreen && onScreen.sessionId !== sessionId) {
      logger.info(
        `[QuestionManager] A poll of another session is on screen, not starting poll: requestID=${requestID}`,
      );
      return false;
    }

    if (current?.kind === "question") {
      logger.info(`[QuestionManager] Poll already active! Replacing it with the new poll.`);
    }

    logger.info(
      `[QuestionManager] Starting new poll with ${questions.length} questions, requestID=${requestID}`,
    );
    this.interactionManager.start(
      {
        kind: "question",
        expectedInput: "callback",
        payload: {
          questions,
          currentIndex: 0,
          selectedOptions: new Map(),
          customAnswers: new Map(),
          selectedCustomAnswers: new Set(),
          customInputQuestionIndex: null,
          activeMessageId: null,
          messageIds: [],
          requestID,
          sessionId,
          answeredFromTelegram: false,
          dismissing: false,
          settledWhileSending: null,
          lastCancelFailed: false,
        },
      },
      scope,
    );
    return true;
  }

  getRequestID(scope: string = DEFAULT_INTERACTION_SCOPE): string | null {
    return this.stateOf(scope)?.requestID ?? null;
  }

  getSessionId(scope: string = DEFAULT_INTERACTION_SCOPE): string | null {
    return this.stateOf(scope)?.sessionId ?? null;
  }

  /**
   * The poll's answers are being sent from Telegram: OpenCode's own reply event is ours.
   * A custom-text wait ends here, so text typed afterwards is never taken as an answer.
   */
  startAnswer(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (state) {
      state.answeredFromTelegram = true;
      state.settledWhileSending = null;
      state.lastCancelFailed = false;
      state.customInputQuestionIndex = null;
    }
  }

  isAnswering(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.stateOf(scope)?.answeredFromTelegram ?? false;
  }

  /**
   * The answers did not reach OpenCode: the poll stays answerable. A custom answer of a
   * single-select question is dropped, so it is typed again after a new Custom answer tap.
   */
  failAnswer(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (!state) {
      return;
    }

    state.answeredFromTelegram = false;
    state.settledWhileSending = null;
    if (!state.questions[state.currentIndex]?.multiple) {
      state.customAnswers.delete(state.currentIndex);
    }
  }

  /**
   * Cancel was tapped: the dismissal is being sent to OpenCode. A custom-text wait ends
   * here, so text typed afterwards is never taken as an answer.
   */
  startDismissal(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (state) {
      state.dismissing = true;
      state.settledWhileSending = null;
      state.lastCancelFailed = false;
      state.customInputQuestionIndex = null;
    }
  }

  isDismissing(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.stateOf(scope)?.dismissing ?? false;
  }

  /** The dismissal did not reach OpenCode: the poll stays answerable. */
  failDismissal(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (state) {
      state.dismissing = false;
      state.settledWhileSending = null;
      state.lastCancelFailed = true;
    }
  }

  /** OpenCode reported the question settled while the answers or the dismissal were on their way. */
  noteSettledWhileSending(
    outcome: QuestionSettledOutcome,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    const state = this.stateOf(scope);
    if (
      (state?.dismissing || state?.answeredFromTelegram) &&
      state.settledWhileSending !== "answered"
    ) {
      state.settledWhileSending = outcome;
    }
  }

  getSettledWhileSending(scope: string = DEFAULT_INTERACTION_SCOPE): QuestionSettledOutcome | null {
    return this.stateOf(scope)?.settledWhileSending ?? null;
  }

  hasLastCancelFailed(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.stateOf(scope)?.lastCancelFailed ?? false;
  }

  clearLastCancelFailed(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (state) {
      state.lastCancelFailed = false;
    }
  }

  /** Answers or a dismissal are being sent from Telegram: the poll is left to that send. */
  isSettlingFromTelegram(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    const state = this.stateOf(scope);
    return (state?.answeredFromTelegram ?? false) || (state?.dismissing ?? false);
  }

  /** The question's poll message is on its way to the chat; an entry already there is kept. */
  trackInFlight(requestID: string, sessionId: string): void {
    if (!this.inFlight.has(requestID)) {
      this.inFlight.set(requestID, { sessionId, ending: null });
    }
  }

  untrackInFlight(requestID: string): void {
    this.inFlight.delete(requestID);
  }

  /** Records how a question in flight ended. The first ending wins. */
  endInFlight(requestID: string, ending: QuestionInFlightEnding): void {
    const entry = this.inFlight.get(requestID);
    if (entry && entry.ending === null) {
      entry.ending = ending;
      logger.info(`[QuestionManager] Poll in flight ended: requestID=${requestID}, ending=${ending}`);
    }
  }

  endInFlightForSession(sessionId: string, ending: QuestionInFlightEnding): void {
    for (const [requestID, entry] of this.inFlight) {
      if (entry.sessionId === sessionId) {
        this.endInFlight(requestID, ending);
      }
    }
  }

  endAllInFlight(ending: QuestionInFlightEnding): void {
    for (const requestID of this.inFlight.keys()) {
      this.endInFlight(requestID, ending);
    }
  }

  getInFlightEnding(requestID: string): QuestionInFlightEnding | null {
    return this.inFlight.get(requestID)?.ending ?? null;
  }

  getCurrentQuestion(scope: string = DEFAULT_INTERACTION_SCOPE): Question | null {
    const state = this.stateOf(scope);
    return state?.questions[state.currentIndex] ?? null;
  }

  selectOption(
    questionIndex: number,
    optionIndex: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    const state = this.stateOf(scope);
    if (!state) {
      return;
    }

    const question = state.questions[questionIndex];
    if (!question) {
      return;
    }

    const selected = state.selectedOptions.get(questionIndex) || new Set();

    if (question.multiple) {
      if (selected.has(optionIndex)) {
        selected.delete(optionIndex);
      } else {
        selected.add(optionIndex);
      }
    } else {
      selected.clear();
      selected.add(optionIndex);
    }

    state.selectedOptions.set(questionIndex, selected);

    logger.debug(
      `[QuestionManager] Selected options for question ${questionIndex}: ${Array.from(selected).join(", ")}`,
    );
  }

  getSelectedOptions(
    questionIndex: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): Set<number> {
    return this.stateOf(scope)?.selectedOptions.get(questionIndex) || new Set();
  }

  getSelectedAnswer(
    questionIndex: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): string {
    const state = this.stateOf(scope);
    const question = state?.questions[questionIndex];
    if (!state || !question) {
      return "";
    }

    const selected = state.selectedOptions.get(questionIndex) || new Set();
    const options = Array.from(selected).flatMap((idx) => {
      const opt = question.options[idx];
      return opt ? [formatOptionLine(opt)] : [];
    });

    return options.join("\n");
  }

  setCustomAnswer(
    questionIndex: number,
    answer: string,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    logger.debug(
      `[QuestionManager] Custom answer received for question ${questionIndex}: ${answer}`,
    );
    const state = this.stateOf(scope);
    if (!state) {
      return;
    }

    state.customAnswers.set(questionIndex, answer);
    if (state.questions[questionIndex]?.multiple) {
      state.selectedCustomAnswers.add(questionIndex);
    }
  }

  getCustomAnswer(
    questionIndex: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): string | undefined {
    return this.stateOf(scope)?.customAnswers.get(questionIndex);
  }

  hasCustomAnswer(
    questionIndex: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): boolean {
    return this.stateOf(scope)?.customAnswers.has(questionIndex) ?? false;
  }

  /** Ticks or unticks the custom answer of a multi-select question, like an option. */
  toggleCustomAnswer(
    questionIndex: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    const state = this.stateOf(scope);
    if (!state || !state.customAnswers.has(questionIndex)) {
      return;
    }

    if (state.selectedCustomAnswers.has(questionIndex)) {
      state.selectedCustomAnswers.delete(questionIndex);
    } else {
      state.selectedCustomAnswers.add(questionIndex);
    }
  }

  isCustomAnswerSelected(
    questionIndex: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): boolean {
    return this.stateOf(scope)?.selectedCustomAnswers.has(questionIndex) ?? false;
  }

  hasAnswer(questionIndex: number, scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.getAnswerItems(questionIndex, scope).length > 0;
  }

  /**
   * The answer items sent to the agent for one question. A multi-select question
   * sends its ticked options, then the ticked custom answer as one more item.
   */
  getAnswerItems(questionIndex: number, scope: string = DEFAULT_INTERACTION_SCOPE): string[] {
    const question = this.stateOf(scope)?.questions[questionIndex];
    if (!question) {
      return [];
    }

    const selectedAnswer = this.getSelectedAnswer(questionIndex, scope);
    const customAnswer = this.getCustomAnswer(questionIndex, scope);

    if (!question.multiple) {
      // Each option is formatted as "* Label: Description"
      const answer = customAnswer || selectedAnswer;
      return answer.split("\n").filter((part) => part.trim());
    }

    const items = selectedAnswer.split("\n").filter((part) => part.trim());
    if (customAnswer && this.isCustomAnswerSelected(questionIndex, scope)) {
      items.push(customAnswer);
    }

    return items;
  }

  /**
   * The answer items sent to OpenCode for one question. A choice that carries a value is
   * sent as that value; one without is sent as its display line, like `getAnswerItems`.
   */
  getReplyItems(questionIndex: number, scope: string = DEFAULT_INTERACTION_SCOPE): string[] {
    const question = this.stateOf(scope)?.questions[questionIndex];
    if (!question) {
      return [];
    }

    const customAnswer = this.getCustomAnswer(questionIndex, scope);
    if (!question.multiple && customAnswer) {
      return this.getAnswerItems(questionIndex, scope);
    }

    const items = Array.from(this.getSelectedOptions(questionIndex, scope)).flatMap((idx) => {
      const opt = question.options[idx];
      if (!opt) {
        return [];
      }
      if (opt.value !== undefined) {
        return [opt.value];
      }
      return formatOptionLine(opt)
        .split("\n")
        .filter((part) => part.trim());
    });

    if (question.multiple && customAnswer && this.isCustomAnswerSelected(questionIndex, scope)) {
      items.push(customAnswer);
    }

    return items;
  }

  nextQuestion(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (!state) {
      return;
    }

    state.currentIndex++;
    state.customInputQuestionIndex = null;
    state.activeMessageId = null;

    logger.debug(
      `[QuestionManager] Moving to next question: ${state.currentIndex}/${state.questions.length}`,
    );
  }

  hasNextQuestion(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    const state = this.stateOf(scope);
    return state !== null && state.currentIndex < state.questions.length;
  }

  getCurrentIndex(scope: string = DEFAULT_INTERACTION_SCOPE): number {
    return this.stateOf(scope)?.currentIndex ?? 0;
  }

  getTotalQuestions(scope: string = DEFAULT_INTERACTION_SCOPE): number {
    return this.stateOf(scope)?.questions.length ?? 0;
  }

  addMessageId(messageId: number, scope: string = DEFAULT_INTERACTION_SCOPE): void {
    this.stateOf(scope)?.messageIds.push(messageId);
  }

  setActiveMessageId(messageId: number, scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (state) {
      state.activeMessageId = messageId;
    }
  }

  getActiveMessageId(scope: string = DEFAULT_INTERACTION_SCOPE): number | null {
    return this.stateOf(scope)?.activeMessageId ?? null;
  }

  isActiveMessage(
    messageId: number | null,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): boolean {
    const activeMessageId = this.getActiveMessageId(scope);
    return activeMessageId !== null && messageId === activeMessageId;
  }

  startCustomInput(questionIndex: number, scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (!state || !state.questions[questionIndex]) {
      return;
    }

    state.customInputQuestionIndex = questionIndex;
  }

  clearCustomInput(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (state) {
      state.customInputQuestionIndex = null;
    }
  }

  isWaitingForCustomInput(
    questionIndex: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): boolean {
    return this.stateOf(scope)?.customInputQuestionIndex === questionIndex;
  }

  getMessageIds(scope: string = DEFAULT_INTERACTION_SCOPE): number[] {
    return [...(this.stateOf(scope)?.messageIds ?? [])];
  }

  isActive(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    const active = this.stateOf(scope) !== null;
    logger.debug(`[QuestionManager] isActive check: scope=${scope}, active=${active}`);
    return active;
  }

  cancel(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    logger.info(`[QuestionManager] Poll cancelled: scope=${scope}`);
    this.interactionManager.clearKind("question", "question_cancelled", scope);
  }

  clear(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    this.interactionManager.clearKind("question", "question_cleared", scope);
  }

  getAllAnswers(scope: string = DEFAULT_INTERACTION_SCOPE): QuestionAnswer[] {
    const state = this.stateOf(scope);
    const answers: QuestionAnswer[] = [];
    if (!state) {
      return answers;
    }

    for (let i = 0; i < state.questions.length; i++) {
      const question = state.questions[i];
      if (!question) {
        continue;
      }
      const finalAnswer = question.multiple
        ? this.getAnswerItems(i, scope).join("\n")
        : this.getCustomAnswer(i, scope) || this.getSelectedAnswer(i, scope);

      if (finalAnswer) {
        answers.push({
          question: question.question,
          answer: finalAnswer,
        });
      }
    }

    return answers;
  }
}
