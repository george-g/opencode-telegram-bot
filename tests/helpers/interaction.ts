import type { InteractionManager } from "../../src/app/managers/interaction-manager.js";
import type {
  InteractionKind,
  InteractionState,
  StartInteractionOptions,
} from "../../src/app/types/interaction.js";

type TestInteractionOptions = Omit<StartInteractionOptions, "kind" | "payload"> & {
  kind: InteractionKind;
};

/**
 * Opens the given interaction slot for guard-level tests that only care about the
 * kind, filling a stateful kind with empty data. The optional scope names the chat
 * and topic; the default scope keeps the call sites that predate topics working.
 */
export function startInteractionForTest(
  interactionManager: InteractionManager,
  options: TestInteractionOptions,
  scope?: string,
): InteractionState {
  const start = (state: StartInteractionOptions): InteractionState =>
    interactionManager.start(state, scope);

  switch (options.kind) {
    case "question":
      return start({
        ...options,
        kind: "question",
        payload: {
          questions: [],
          currentIndex: 0,
          selectedOptions: new Map(),
          customAnswers: new Map(),
          selectedCustomAnswers: new Set(),
          customInputQuestionIndex: null,
          activeMessageId: null,
          messageIds: [],
          requestID: null,
          sessionId: "session-test",
          answeredFromTelegram: false,
          dismissing: false,
          settledWhileSending: null,
          lastCancelFailed: false,
        },
      });
    case "permission":
      return start({
        ...options,
        kind: "permission",
        payload: {
          requestsByMessageId: new Map(),
          requestIdsByMessageId: new Map(),
          messageIdBySignature: new Map(),
          sendsByMessageId: new Map(),
        },
      });
    case "rename":
      return start({
        ...options,
        kind: "rename",
        payload: {
          sessionId: "session-test",
          sessionDirectory: "D:/repo",
          currentTitle: "Test session",
          messageId: null,
        },
      });
    case "task":
      return start({
        ...options,
        kind: "task",
        payload: {
          stage: "awaiting_schedule",
          projectId: "project-test",
          projectWorktree: "D:/repo",
          agent: "build",
          model: { providerID: "test-provider", modelID: "test-model", variant: null },
          scheduleText: null,
          parsedSchedule: null,
          scheduleRequestMessageId: null,
          previewMessageId: null,
          promptRequestMessageId: null,
        },
      });
    case "inline":
    case "custom":
      return start({ ...options, kind: options.kind });
  }
}
