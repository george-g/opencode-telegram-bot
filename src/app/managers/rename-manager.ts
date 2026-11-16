import type { RenameState } from "../types/rename.js";
import type { InteractionManager } from "./interaction-manager.js";
import { DEFAULT_INTERACTION_SCOPE } from "../types/interaction-scope.js";
import { logger } from "../../utils/logger.js";

/**
 * The rename flow of one interaction scope. The flow lives in the slot of its own
 * chat and topic, so a rename in one topic never blocks or replaces one in another.
 */
export class RenameManager {
  constructor(private readonly interactionManager: InteractionManager) {}

  private stateOf(scope: string): RenameState | null {
    return this.interactionManager.getPayload("rename", scope);
  }

  startWaiting(
    sessionId: string,
    directory: string,
    currentTitle: string,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): void {
    logger.info(`[RenameManager] Starting rename flow for session: ${sessionId}`);
    this.interactionManager.start(
      {
        kind: "rename",
        expectedInput: "text",
        payload: {
          sessionId,
          sessionDirectory: directory,
          currentTitle,
          messageId: null,
        },
      },
      scope,
    );
  }

  setMessageId(messageId: number, scope: string = DEFAULT_INTERACTION_SCOPE): void {
    const state = this.stateOf(scope);
    if (state) {
      state.messageId = messageId;
    }
  }

  getMessageId(scope: string = DEFAULT_INTERACTION_SCOPE): number | null {
    return this.stateOf(scope)?.messageId ?? null;
  }

  isActiveMessage(
    messageId: number | null,
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): boolean {
    const activeMessageId = this.getMessageId(scope);
    return activeMessageId !== null && activeMessageId === messageId;
  }

  isWaitingForName(scope: string = DEFAULT_INTERACTION_SCOPE): boolean {
    return this.stateOf(scope) !== null;
  }

  getSessionInfo(
    scope: string = DEFAULT_INTERACTION_SCOPE,
  ): { sessionId: string; directory: string; currentTitle: string } | null {
    const state = this.stateOf(scope);
    if (!state || !state.sessionId) {
      return null;
    }
    return {
      sessionId: state.sessionId,
      directory: state.sessionDirectory,
      currentTitle: state.currentTitle,
    };
  }

  clear(scope: string = DEFAULT_INTERACTION_SCOPE): void {
    logger.debug("[RenameManager] Clearing rename state");
    this.interactionManager.clearKind("rename", "rename_cleared", scope);
  }
}
