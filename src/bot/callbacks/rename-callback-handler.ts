import { Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { opencodeClient } from "../../opencode/client.js";
import { setCurrentSession } from "../../app/services/session-service.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { cancelPrompt } from "./feedback.js";
import { RENAME_CANCEL_CALLBACK } from "../menus/rename-menu.js";
import { getInteractionScope } from "../middleware/interaction-scope.js";

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

export type RenameCallbackDeps = Pick<
  AppContainer,
  "interactionManager" | "pinnedMessageManager" | "renameManager"
>;

function clearRenameInteraction(deps: RenameCallbackDeps, reason: string, scope: string): void {
  const state = deps.interactionManager.getSnapshot(scope);
  if (state?.kind === "rename") {
    deps.interactionManager.clear(reason, scope);
  }
}

export async function handleRenameCancel(ctx: Context, deps: RenameCallbackDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || data !== RENAME_CANCEL_CALLBACK) {
    return false;
  }

  logger.debug("[RenameHandler] Cancel callback received");

  const scope = getInteractionScope(ctx);
  if (!deps.renameManager.isWaitingForName(scope)) {
    clearRenameInteraction(deps, "rename_cancel_inactive", scope);
    await ctx.answerCallbackQuery({ text: t("rename.inactive_callback"), show_alert: true });
    return true;
  }

  const interactionState = deps.interactionManager.getSnapshot(scope);
  if (interactionState?.kind !== "rename") {
    deps.renameManager.clear(scope);
    await ctx.answerCallbackQuery({ text: t("rename.inactive_callback"), show_alert: true });
    return true;
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  if (!deps.renameManager.isActiveMessage(callbackMessageId, scope)) {
    await ctx.answerCallbackQuery({ text: t("rename.inactive_callback"), show_alert: true });
    return true;
  }

  clearRenameInteraction(deps, "rename_cancelled", scope);
  deps.renameManager.clear(scope);

  await cancelPrompt(ctx, "rename.cancelled");

  return true;
}

export async function handleRenameTextAnswer(
  ctx: Context,
  deps: RenameCallbackDeps,
): Promise<boolean> {
  const scope = getInteractionScope(ctx);
  if (!deps.renameManager.isWaitingForName(scope)) {
    return false;
  }

  const text = ctx.message?.text;
  if (text === undefined) {
    return false;
  }

  if (text.startsWith("/")) {
    return false;
  }

  const interactionState = deps.interactionManager.getSnapshot(scope);
  if (interactionState?.kind !== "rename") {
    deps.renameManager.clear(scope);
    await ctx.reply(t("rename.inactive"));
    return true;
  }

  const sessionInfo = deps.renameManager.getSessionInfo(scope);
  if (!sessionInfo) {
    clearRenameInteraction(deps, "rename_missing_session_info", scope);
    deps.renameManager.clear(scope);
    // Answer here: returning false would send the new title to OpenCode as a prompt.
    await ctx.reply(t("rename.inactive"));
    return true;
  }

  const newTitle = text.trim();
  if (!newTitle) {
    await ctx.reply(t("rename.empty_title"));
    return true;
  }

  logger.info(`[RenameHandler] Renaming session ${sessionInfo.sessionId} to: ${newTitle}`);

  try {
    const { data: updatedSession, error } = await opencodeClient.session.update({
      sessionID: sessionInfo.sessionId,
      directory: sessionInfo.directory,
      title: newTitle,
    });

    if (error || !updatedSession) {
      throw error || new Error("Failed to update session");
    }

    setCurrentSession({
      id: sessionInfo.sessionId,
      title: newTitle,
      directory: sessionInfo.directory,
    });

    if (deps.pinnedMessageManager.isInitialized()) {
      await deps.pinnedMessageManager.onSessionChange(sessionInfo.sessionId, newTitle, {
        directory: sessionInfo.directory,
      });
    }

    const messageId = deps.renameManager.getMessageId(scope);
    if (messageId && ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {});
    }

    await ctx.reply(t("rename.success", { title: newTitle }));

    logger.info(`[RenameHandler] Session renamed successfully: ${newTitle}`);
  } catch (error) {
    logger.error("[RenameHandler] Error renaming session:", error);
    await ctx.reply(t("rename.error"));
  }

  clearRenameInteraction(deps, "rename_completed", scope);
  deps.renameManager.clear(scope);
  return true;
}
