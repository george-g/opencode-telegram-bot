import type { ParsedTaskSchedule, ScheduledTaskModel, TaskCreationState } from "../types/scheduled-task.js";
import { cloneParsedTaskSchedule, cloneScheduledTaskModel } from "../types/scheduled-task.js";
import type { InteractionManager } from "./interaction-manager.js";
import { DEFAULT_INTERACTION_SCOPE } from "../types/interaction-scope.js";
import { logger } from "../../utils/logger.js";

function cloneState(state: TaskCreationState): TaskCreationState {
  return {
    ...state,
    model: cloneScheduledTaskModel(state.model),
    parsedSchedule: state.parsedSchedule ? cloneParsedTaskSchedule(state.parsedSchedule) : null,
  };
}

/**
 * The task creation flow of one interaction scope. The flow lives in the slot of
 * its own chat and topic, so a task being written in one topic never blocks one in
 * another.
 */
export class TaskCreationManager {
  constructor(private readonly interactionManager: InteractionManager) {}

  private stateOf(scope: string): TaskCreationState | null {
    return this.interactionManager.getPayload("task", scope);
  }

  private update(
    changes: Partial<TaskCreationState>,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): TaskCreationState | null {
    const state = this.stateOf(scope);
    if (!state) {
      return null;
    }

    Object.assign(state, changes);
    return cloneState(state);
  }

  start(
    projectId: string,
    projectWorktree: string,
    model: ScheduledTaskModel,
    agent: string,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): TaskCreationState {
    const state: TaskCreationState = {
      stage: "awaiting_schedule",
      projectId,
      projectWorktree,
      agent,
      model: cloneScheduledTaskModel(model),
      scheduleText: null,
      parsedSchedule: null,
      scheduleRequestMessageId: null,
      previewMessageId: null,
      promptRequestMessageId: null,
    };
    this.interactionManager.start(
      { kind: "task", expectedInput: "text", payload: state },
      scope,
    );

    logger.info(`[TaskCreationManager] Started task creation flow for project=${projectWorktree}`);

    return cloneState(state);
  }

  isActive(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.stateOf(scope) !== null;
  }

  isWaitingForSchedule(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.stateOf(scope)?.stage === "awaiting_schedule";
  }

  isParsingSchedule(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.stateOf(scope)?.stage === "parsing_schedule";
  }

  isWaitingForPrompt(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.stateOf(scope)?.stage === "awaiting_prompt";
  }

  getState(scope: string = DEFAULT_INTERACTION_SCOPE): TaskCreationState | null {
    const state = this.stateOf(scope);
    return state ? cloneState(state) : null;
  }

  setParsedSchedule(
    scheduleText: string,
    parsedSchedule: ParsedTaskSchedule,
    previewMessageId: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): TaskCreationState | null {
    const state = this.update(
      {
        stage: "awaiting_prompt",
        scheduleText,
        parsedSchedule: cloneParsedTaskSchedule(parsedSchedule),
        scheduleRequestMessageId: null,
        previewMessageId,
        promptRequestMessageId: null,
      },
      scope,
    );

    if (state) {
      logger.info("[TaskCreationManager] Parsed schedule and switched flow to prompt input");
    }

    return state;
  }

  markScheduleParsing(scope: string = DEFAULT_INTERACTION_SCOPE): TaskCreationState | null {
    const state = this.update({ stage: "parsing_schedule" }, scope);

    if (state) {
      logger.info("[TaskCreationManager] Schedule parsing started");
    }

    return state;
  }

  setPromptRequestMessageId(
    messageId: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): TaskCreationState | null {
    return this.update({ promptRequestMessageId: messageId }, scope);
  }

  setScheduleRequestMessageId(
    messageId: number,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): TaskCreationState | null {
    return this.update({ scheduleRequestMessageId: messageId }, scope);
  }

  resetSchedule(scope: string = DEFAULT_INTERACTION_SCOPE): TaskCreationState | null {
    const state = this.update(
      {
        stage: "awaiting_schedule",
        scheduleText: null,
        parsedSchedule: null,
        scheduleRequestMessageId: null,
        previewMessageId: null,
        promptRequestMessageId: null,
      },
      scope,
    );

    if (state) {
      logger.info("[TaskCreationManager] Reset task creation flow back to schedule input");
    }

    return state;
  }

  clear(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    if (!this.stateOf(scope)) {
      return;
    }

    logger.debug("[TaskCreationManager] Clearing task creation state");
    this.interactionManager.clearKind("task", "task_creation_cleared", scope);
  }
}
