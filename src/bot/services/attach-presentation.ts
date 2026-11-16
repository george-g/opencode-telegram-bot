import type { AppContainer } from "../../app/bootstrap/app-container.js";
import type { AttachPresentationDeps } from "../../app/services/attach-service.js";
import {
  applyPermissionPromptChanges,
  showPermissionRequest,
  type PermissionMenuDeps,
} from "../menus/permission-menu.js";
import {
  closeQuestionNotAnswered,
  closeQuestionSettledOutside,
  showCurrentQuestion,
  type QuestionMenuDeps,
} from "../menus/question-menu.js";

type AttachPresentationFactoryDeps = Pick<AppContainer, "keyboardManager" | "pinnedMessageManager"> &
  PermissionMenuDeps &
  QuestionMenuDeps;

export function createAttachPresentation(
  deps: AttachPresentationFactoryDeps,
): AttachPresentationDeps {
  const { keyboardManager, pinnedMessageManager } = deps;

  return {
    async preparePinnedSession({
      api,
      chatId,
      session,
      forceFullRestore = false,
      sessionCreated = false,
    }) {
      if (!pinnedMessageManager.isInitialized()) {
        pinnedMessageManager.initialize(api, chatId);
      }

      keyboardManager.initialize(api, chatId);

      const pinnedState = pinnedMessageManager.getState();
      if (pinnedState.sessionId === session.id && pinnedState.messageId) {
        // Back to the session on screen: a change still loading must not replace its dashboard.
        pinnedMessageManager.dropPendingPrepare();
        if (forceFullRestore) {
          await pinnedMessageManager.loadContextFromHistory(session.id, session.directory);
        }
        return;
      }

      if (pinnedState.messageId && pinnedState.sessionId === null) {
        await pinnedMessageManager.prepareRestore(session.id, session.title, session.directory);
      } else {
        await pinnedMessageManager.prepareSessionChange(session.id, session.title, {
          directory: session.directory,
          created: sessionCreated,
        });
      }
    },
    async showPinnedSession() {
      await pinnedMessageManager.showPreparedSession();

      const contextInfo = pinnedMessageManager.getContextInfo();
      if (contextInfo) {
        keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
      }
    },
    async syncAttachState(attached, busy) {
      if (!pinnedMessageManager.isInitialized()) {
        return;
      }

      await pinnedMessageManager.setAttachState(attached, busy);
    },
    showCurrentQuestion: (api, chatId, scope) => showCurrentQuestion(api, chatId, deps, scope),
    showPermissionRequest: (api, chatId, request, scope) =>
      showPermissionRequest(api, chatId, request, deps, undefined, scope),
    applyPermissionPromptChanges: (api, chatId, changes, scope) =>
      applyPermissionPromptChanges(api, chatId, changes, deps, scope),
    closeQuestionSettledOutside: (api, chatId, scope) =>
      closeQuestionSettledOutside(api, chatId, "answered", deps, scope),
    closeQuestionNotAnswered: (api, chatId, scope) =>
      closeQuestionNotAnswered(api, chatId, deps, scope),
  };
}
