import type { Bot, Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { opencodeClient } from "../../opencode/client.js";
import {
  getStoredAgent,
  resolveProjectAgent,
  selectAgent,
} from "../../app/services/agent-selection-service.js";
import { getStoredModel, selectModel } from "../../app/services/model-selection-service.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { BackgroundSessionTrackerSnapshot } from "../../app/managers/background-session-manager.js";
import { setCurrentSession } from "../../app/services/session-service.js";
import { markSessionReplyRead } from "../../app/services/session-reply-read-service.js";
import { applySessionSettings } from "../../app/services/session-settings-service.js";
import type { SessionInfo } from "../../app/types/session.js";
import type { ProjectInfo } from "../../app/types/project.js";
import { getCurrentProject, getCurrentSession } from "../../app/stores/settings-store.js";
import {
  getTopicBindingBySession,
  registerTopicBinding,
  removeTopicBinding,
} from "../../app/stores/topic-binding-store.js";
import { switchToProject } from "../../app/services/project-switch-service.js";
import { normalizePathKey } from "../../app/services/worktree-service.js";
import { createProjectSwitchPresentation } from "../services/project-switch-presentation.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { getProjectFolderName } from "../menus/project-selection-menu.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { logger } from "../../utils/logger.js";
import { isTopicNotFoundError } from "../../utils/telegram-topic-error.js";
import { dropDeadTopicBinding } from "../events/topic-binding-recovery.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { formatSessionTitle } from "../../app/formatters/session-title-formatter.js";
import { alert, cancelMenu, failure } from "./feedback.js";
import { getInteractionScope } from "../middleware/interaction-scope.js";
import { attachToSession, type AttachSessionResult } from "../../app/services/attach-service.js";
import { renderAssistantFinalPartsSafe } from "../messages/assistant-rendering.js";
import {
  prepareAssistantDocuments,
  deliverAssistantDocuments,
} from "../messages/assistant-document-delivery.js";
import {
  AGENT_TEXT_LINK_PREVIEW_OPTIONS,
  sendBotText,
  sendRenderedBotPart,
} from "../messages/telegram-text.js";
import {
  buildSessionPickQuote,
  findEligibleReply,
  findLatestUserPrompt,
  findMessageById,
  findPendingUserPrompt,
  type SessionPickMessage,
} from "../../app/services/session-pick-reply.js";
import type { QuotedNotification } from "../../app/services/quoted-notification.js";
import {
  buildSessionSelectionMenuView,
  parseBackgroundSessionCallback,
  parseSessionIdCallback,
  parseSessionPageCallback,
  SESSION_CALLBACK_PREFIX,
  SESSION_SEARCH_QUERY_MAX_LENGTH,
  loadSessionPage,
  searchSessions,
  buildSessionSearchView,
} from "../menus/session-selection-menu.js";

export type SessionSelectDeps = Pick<
  AppContainer,
  | "attachManager"
  | "ensureEventSubscription"
  | "foregroundSessionState"
  | "interactionManager"
  | "keyboardManager"
  | "permissionManager"
  | "pinnedMessageManager"
  | "questionManager"
  | "resetInteractions"
  | "summaryAggregator"
> & {
  bot: Bot<Context>;
};

/** The managers a project switch needs on top of the ones a session selection needs. */
export type BackgroundSessionOpenDeps = SessionSelectDeps &
  Pick<AppContainer, "backgroundSessionTracker" | "goalManager" | "resetAggregator">;

type SessionSearchDeps = Pick<AppContainer, "interactionManager">;

function sessionSearchState(deps: SessionSearchDeps, scope: string) {
  const state = deps.interactionManager.getSnapshot(scope);
  return state?.kind === "custom" && state.metadata.flow === "session-search"
    ? state.metadata
    : null;
}

function sameSessionSearch(
  deps: SessionSearchDeps,
  scope: string,
  state: Record<string, unknown>,
): boolean {
  const current = sessionSearchState(deps, scope);
  return !!current && current.token === state.token && current.stage === state.stage;
}

function startSessionSearch(deps: SessionSearchDeps, scope: string): void {
  deps.interactionManager.start(
    {
      kind: "custom",
      expectedInput: "text",
      allowedCommands: [],
      metadata: { flow: "session-search", stage: "input", token: Symbol("session-search") },
    },
    scope,
  );
}

export async function handleSessionSearchTextInput(
  ctx: Context,
  deps: SessionSearchDeps,
): Promise<boolean> {
  const scope = getInteractionScope(ctx);
  const state = sessionSearchState(deps, scope);
  if (!state || state.stage !== "input" || ctx.message?.text === undefined) return false;
  // A session title never comes near this length; the cap keeps the heading sendable.
  const query = ctx.message.text.slice(0, SESSION_SEARCH_QUERY_MAX_LENGTH);
  if (!query.trim()) return true;
  try {
    const project = getCurrentProject();
    if (!project) throw new Error("Project no longer selected");
    const sessions = await searchSessions(project.worktree, query);
    if (!sameSessionSearch(deps, scope, state)) return true;
    const view = buildSessionSearchView(sessions, query, 0, config.bot.sessionsListLimit);
    const sent = await ctx.reply(view.text, { reply_markup: view.keyboard });
    if (!sameSessionSearch(deps, scope, state)) return true;
    deps.interactionManager.transition(
      {
        expectedInput: "callback",
        metadata: {
          ...state,
          stage: "results",
          query,
          messageId: sent.message_id,
          ids: sessions.map((session) => session.id),
        },
      },
      scope,
    );
  } catch (error) {
    logger.error("[Sessions] Error searching sessions:", error);
    if (sameSessionSearch(deps, scope, state)) {
      deps.interactionManager.clear("session_search_error", scope);
      await ctx.reply(t("sessions.fetch_error"));
    }
  }
  return true;
}

export async function handleSessionSearchCallback(
  ctx: Context,
  deps: SessionSelectDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || (data !== "session:search" && !data.startsWith("session:search:"))) return false;
  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }
  const scope = getInteractionScope(ctx);
  if (data === "session:search") {
    if (!(await ensureActiveInlineMenu(ctx, "session", deps))) return true;
    const initial = deps.interactionManager.getSnapshot(scope);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    const current = deps.interactionManager.getSnapshot(scope);
    if (current?.kind !== "inline" || current.metadata.messageId !== initial?.metadata.messageId)
      return true;
    startSessionSearch(deps, scope);
    await ctx.reply(t("sessions.search.prompt"));
    return true;
  }
  const state = sessionSearchState(deps, scope);
  if (
    !state ||
    state.stage !== "results" ||
    state.messageId !== ctx.callbackQuery?.message?.message_id
  ) {
    await ctx
      .answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true })
      .catch(() => {});
    return true;
  }
  if (data === "session:search:cancel") {
    deps.interactionManager.clear("session_search_cancelled", scope);
    await cancelMenu(ctx);
    return true;
  }
  if (data === "session:search:again") {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    if (!sameSessionSearch(deps, scope, state)) return true;
    startSessionSearch(deps, scope);
    await ctx.reply(t("sessions.search.prompt"));
    return true;
  }
  if (data.startsWith("session:search:page:")) {
    const raw = data.slice("session:search:page:".length);
    if (!/^\d+$/.test(raw) || typeof state.query !== "string") return true;
    try {
      const project = getCurrentProject();
      if (!project) throw new Error("Project no longer selected");
      const sessions = await searchSessions(project.worktree, state.query);
      if (!sameSessionSearch(deps, scope, state)) {
        await ctx.answerCallbackQuery().catch(() => {});
        return true;
      }
      const view = buildSessionSearchView(
        sessions,
        state.query,
        Number(raw),
        config.bot.sessionsListLimit,
      );
      await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
      if (!sameSessionSearch(deps, scope, state)) {
        await ctx.answerCallbackQuery().catch(() => {});
        return true;
      }
      deps.interactionManager.transition(
        {
          expectedInput: "callback",
          metadata: { ...state, ids: sessions.map((session) => session.id) },
        },
        scope,
      );
      await ctx.answerCallbackQuery();
    } catch (error) {
      logger.error("[Sessions] Error loading search page:", error);
      await ctx.answerCallbackQuery({ text: t("sessions.page_load_error_callback") });
    }
    return true;
  }
  if (data.startsWith("session:search:result:")) {
    const raw = data.slice("session:search:result:".length);
    const id = /^\d+$/.test(raw) && Array.isArray(state.ids) ? state.ids[Number(raw)] : undefined;
    if (typeof id !== "string") {
      await failure(ctx, "sessions.select_error");
      return true;
    }
    try {
      await selectSessionById(ctx, deps, id, {
        source: "menu",
        deleteCallbackMessage: true,
        removeCallbackReplyMarkup: false,
        postSelectAction: "preview",
        searchState: state,
      });
    } catch (error) {
      if (!sameSessionSearch(deps, scope, state)) {
        await ctx.answerCallbackQuery().catch(() => {});
        return true;
      }
      deps.resetInteractions("session_select_error");
      logger.error("[Sessions] Error selecting session:", error);
      await failure(ctx, "sessions.select_error");
    }
    return true;
  }
  return true;
}

interface SelectSessionByIdOptions {
  source: "menu" | "background_notification";
  deleteCallbackMessage: boolean;
  removeCallbackReplyMarkup: boolean;
  postSelectAction: "preview" | "latest_assistant_response" | "none";
  searchState?: Record<string, unknown>;
}

const LATEST_ASSISTANT_RESPONSE_MESSAGES_LIMIT = 20;
const SESSION_PICK_PAGE_SIZE = 20;
const SESSION_PICK_SEND_GAP_MS = 1000;

type SessionMessageLike = {
  info: {
    role?: string;
    summary?: boolean;
    error?: unknown;
    time?: {
      created?: number;
      completed?: number | undefined;
    };
  };
  parts: Array<{ type: string; text?: string }>;
};

async function removeCallbackReplyMarkup(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup();
  } catch (err) {
    logger.debug("[Sessions] Failed to remove background session button:", err);
  }
}

// Telegram rejects a forum topic name longer than this.
const TOPIC_NAME_MAX_LENGTH = 128;

/**
 * The forum topic a session is shown under: its title, kept apart from a
 * same-named session of another project by the project folder. Telegram caps a
 * topic name at 128 characters, so a long one is cut to fit.
 */
export function buildSessionTopicName(title: string, directory: string): string {
  const sessionName = formatSessionTitle(title).trim();
  const projectName = getProjectFolderName(directory);
  const name = projectName ? `${sessionName} · ${projectName}` : sessionName;
  return name.slice(0, TOPIC_NAME_MAX_LENGTH);
}

/** The topic a picked session lives in, together with the chat holding it. */
interface SessionTopic {
  chatId: number;
  threadId: number;
  /** True when this call created the topic. A reused binding sets it to false. */
  created: boolean;
}

/** The send options that keep a message in a session's topic. A chat without a topic sends none. */
function topicSendOptions(threadId: number | null): { message_thread_id?: number } {
  return threadId !== null ? { message_thread_id: threadId } : {};
}

/** The user-facing notice for a topic the bot could not create. */
async function reportTopicCreateFailure(ctx: Context, chatId: number): Promise<void> {
  try {
    await ctx.api.sendMessage(chatId, t("sessions.topic_create_failed"));
  } catch (err) {
    logger.error("[Sessions] Failed to report the topic creation failure:", err);
  }
}

/**
 * The forum topic the picked session should be shown in. A topic already bound
 * to the session is reused, so reconnecting never creates a second one. Chats
 * that cannot hold topics (a private chat, or a chat update with no type) are
 * left exactly as they were. A topic the bot cannot create - the chat is not a
 * forum, the bot lacks the Manage Topics right, per-chat topic limits - degrades
 * gracefully: the user is told and the selection continues in the chat itself.
 */
async function ensureSessionTopic(
  ctx: Context,
  session: SessionInfo,
): Promise<SessionTopic | null> {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    return null;
  }

  const existing = getTopicBindingBySession(session.id);
  if (existing) {
    return { chatId: existing.chatId, threadId: existing.threadId, created: false };
  }

  return createSessionTopic(ctx, session, chat.id);
}

/**
 * Creates the session's topic in the chat and stores its binding. Telegram has
 * no read-only way to look a topic up - there is no `getForumTopic` method - so
 * a binding is only ever written for a topic this call created.
 */
async function createSessionTopic(
  ctx: Context,
  session: SessionInfo,
  chatId: number,
): Promise<SessionTopic | null> {
  const topicName = buildSessionTopicName(session.title, session.directory);
  try {
    const created = await ctx.api.createForumTopic(chatId, topicName);
    await registerTopicBinding({
      chatId,
      threadId: created.message_thread_id,
      sessionId: session.id,
      directory: session.directory,
      topicName,
    });
    logger.info(
      `[Sessions] Created forum topic for session: sessionId=${session.id}, threadId=${created.message_thread_id}`,
    );
    return { chatId, threadId: created.message_thread_id, created: true };
  } catch (error) {
    logger.error("[Sessions] Failed to create a forum topic for the session:", error);
    await reportTopicCreateFailure(ctx, chatId);
    return null;
  }
}

/** The topic to continue the ceremony in, and the id of its loading notice when one went out. */
interface CeremonyTopicOpening {
  topic: SessionTopic | null;
  loadingMessageId: number | null;
}

/**
 * Sends the ceremony's loading notice, which doubles as the topic probe. A
 * deleted topic leaves its binding behind, and every send into it fails with
 * `400 message thread not found`; there is no read-only check for a topic, so
 * the send itself is the check. The stale binding then goes and one fresh topic
 * takes its place, and the ceremony continues in it. Only a reused binding is
 * recreated: a topic this call created itself is never replaced a second time,
 * so one ceremony creates at most one replacement topic. The retry into the
 * fresh topic cannot create a second topic either: its own try/catch keeps the
 * topic and only drops the loading id. A send that fails for any other reason is
 * only logged, as before.
 */
async function sendCeremonyLoadingNotice(
  ctx: Context,
  session: SessionInfo,
  topic: SessionTopic | null,
): Promise<CeremonyTopicOpening> {
  const chat = ctx.chat;
  if (!chat) {
    return { topic, loadingMessageId: null };
  }

  try {
    return { topic, loadingMessageId: await sendLoadingNotice(ctx, topic) };
  } catch (error) {
    if (!topic || topic.created || !isTopicNotFoundError(error)) {
      logger.error("[Sessions] Failed to send loading message:", error);
      return { topic, loadingMessageId: null };
    }

    // The notice went to the chat of the interaction, with the binding's thread
    // id. A binding of another chat fails here for the foreign thread id alone:
    // that chat is not the topic's. The live topic over there keeps its binding
    // and no replacement is made, and the ceremony carries on in this chat
    // without a topic, so no later send reaches a foreign thread either.
    if (chat.id !== topic.chatId) {
      logger.warn(
        `[Sessions] Session topic belongs to another chat, leaving it alone and continuing here: sessionId=${session.id}, topicChatId=${topic.chatId}, threadId=${topic.threadId}, chatId=${chat.id}`,
      );
      return { topic: null, loadingMessageId: null };
    }

    logger.warn(
      `[Sessions] Stored session topic no longer exists, recreating it: sessionId=${session.id}, chatId=${topic.chatId}, threadId=${topic.threadId}`,
    );
    // The removal goes through the shared helper, which logs a failed one itself.
    await dropDeadTopicBinding(topic.chatId, topic.threadId, error);
    // A stale binding that survived must not be shadowed by a fresh topic: the
    // ceremony then carries on with no topic at all.
    if (getTopicBindingBySession(session.id)) {
      logger.error(
        `[Sessions] Stale topic binding survived, skipping the recreation: sessionId=${session.id}, chatId=${topic.chatId}, threadId=${topic.threadId}`,
      );
      return { topic: null, loadingMessageId: null };
    }

    const recreated = await createSessionTopic(ctx, session, chat.id);
    if (!recreated) {
      return { topic: null, loadingMessageId: null };
    }

    try {
      return { topic: recreated, loadingMessageId: await sendLoadingNotice(ctx, recreated) };
    } catch (retryError) {
      logger.error(
        "[Sessions] Failed to send loading message into the recreated topic:",
        retryError,
      );
      return { topic: recreated, loadingMessageId: null };
    }
  }
}

/** The loading notice, in the session's topic when the session has one. */
async function sendLoadingNotice(ctx: Context, topic: SessionTopic | null): Promise<number> {
  const sent = await ctx.api.sendMessage(
    ctx.chat!.id,
    t("sessions.loading_context"),
    topic ? { message_thread_id: topic.threadId } : {},
  );
  return sent.message_id;
}

/**
 * Reports in a session's topic what the attach restored. Prompts the attach
 * restored belong to the chat the session was followed in, not the topic, so
 * they are only reported here; a TODO(topic-start) revisits moving them into
 * the topic once the spike settles where restored prompts should live. A topic
 * receives no message when the attach restored nothing.
 */
async function sendSessionTopicStartMessage(
  api: Context["api"],
  topic: SessionTopic,
  attachResult: AttachSessionResult | null,
): Promise<void> {
  const lines: string[] = [];
  if (attachResult?.restoredQuestion) {
    lines.push(t("attach.restored_question"));
  }
  if (attachResult && attachResult.restoredPermissions > 0) {
    lines.push(t("attach.restored_permissions", { count: attachResult.restoredPermissions }));
  }

  if (lines.length === 0) {
    return;
  }

  try {
    await api.sendMessage(topic.chatId, lines.join("\n"), {
      message_thread_id: topic.threadId,
    });
  } catch (err) {
    logger.error("[Sessions] Failed to send the session topic start message:", err);
  }
}

export async function selectSessionById(
  ctx: Context,
  deps: SessionSelectDeps,
  sessionId: string,
  options: SelectSessionByIdOptions,
): Promise<void> {
  const currentProject = getCurrentProject();

  if (!currentProject) {
    deps.resetInteractions("session_select_project_missing");
    await alert(ctx, "sessions.select_project_first");
    return;
  }

  const { data: session, error } = await opencodeClient.session.get({
    sessionID: sessionId,
    directory: currentProject.worktree,
  });

  if (options.searchState && !sameSessionSearch(deps, getInteractionScope(ctx), options.searchState)) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  if (error || !session) {
    throw error || new Error("Failed to get session details");
  }

  logger.info(
    `[Bot] Session selected: id=${session.id}, title="${session.title}", project=${currentProject.worktree}, source=${options.source}`,
  );

  const sessionInfo: SessionInfo = {
    id: session.id,
    title: session.title,
    directory: currentProject.worktree,
  };
  setCurrentSession(sessionInfo);
  // The attach does not redraw the dashboard already showing this session.
  const pinnedState = deps.pinnedMessageManager.getState();
  const isSessionOnDashboard =
    pinnedState.sessionId === session.id && Boolean(pinnedState.messageId);
  // Pull before attaching: the pinned message is rendered inside attachToSession
  // and reads the stored model, so its Model line comes out already pulled.
  const modelChanged = await applySessionSettings(session);
  deps.resetInteractions("session_switched");

  await ctx.answerCallbackQuery();

  // The topic first: the loading message is its first message. Only an explicit
  // selection reaches this path, so no session gets a topic on its own. A
  // session with no topic (a private chat, or a failed create) keeps the old
  // chat behaviour. The loading notice also probes a reused topic: a deleted one
  // is dropped and replaced once, then the ceremony carries on in the new topic.
  const ensuredTopic = await ensureSessionTopic(ctx, sessionInfo);
  const opening = await sendCeremonyLoadingNotice(ctx, sessionInfo, ensuredTopic);
  const topic = opening.topic;
  const loadingMessageId = opening.loadingMessageId;

  const deliverPick = options.postSelectAction === "preview" && Boolean(ctx.chat);
  let pickMessages: SessionPickMessage[] | null = null;
  let pickGeneration: number | null = null;
  let pickBusy = false;
  if (deliverPick) {
    pickBusy = await readSessionBusy(session.id, currentProject.worktree);
    pickMessages = await loadSessionPickMessages(session.id, currentProject.worktree, pickBusy);
    pickGeneration = deps.summaryAggregator.holdOutbound();
  }

  try {
    let attachResult: AttachSessionResult | null = null;
    try {
      attachResult = await attachToSession({
        ...deps,
        chatId: ctx.chat!.id,
        session: sessionInfo,
      });
    } catch (err) {
      if (loadingMessageId && ctx.chat && !topic) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, loadingMessageId);
        } catch (deleteError) {
          logger.debug(
            "[Sessions] Failed to delete loading message after follow error:",
            deleteError,
          );
        }
      }
      // Only a binding this call created is dropped: a reused binding stays, so
      // its session keeps its topic.
      if (topic?.created) {
        await removeTopicBinding(topic.chatId, topic.threadId).catch((removeError) => {
          logger.error(
            "[Sessions] Failed to drop the topic binding after a follow error:",
            removeError,
          );
        });
      }
      logger.error("[Sessions] Error following selected session:", err);
      throw err;
    }

    if (isSessionOnDashboard && modelChanged) {
      await deps.pinnedMessageManager.onModelChange();
    }

    if (ctx.chat) {
      const chatId = ctx.chat.id;
      const currentAgent = await resolveProjectAgent();

      deps.keyboardManager.updateAgent(currentAgent);
      deps.keyboardManager.updateModel(getStoredModel());

      const contextInfo = deps.keyboardManager.getContextInfo();
      if (contextInfo) {
        deps.keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
      }

      // A loading message in the chat is a transient notice: the topic start
      // message takes its place. In a topic it stays as the first message.
      if (loadingMessageId && !topic) {
        try {
          await ctx.api.deleteMessage(chatId, loadingMessageId);
        } catch (err) {
          logger.debug("[Sessions] Failed to delete loading message:", err);
        }
      }

      if (topic) {
        await sendSessionTopicStartMessage(ctx.api, topic, attachResult);
      }

      if (deliverPick) {
        await sendSessionPickTranscript(
          ctx.api,
          chatId,
          session.id,
          session.directory,
          pickMessages,
          pickBusy,
          topic?.threadId ?? null,
        );
      }

      if (options.postSelectAction === "latest_assistant_response") {
        safeBackgroundTask({
          taskName: "sessions.sendLatestAssistantResponse",
          task: () =>
            sendLatestAssistantResponse(
              ctx.api,
              chatId,
              session.id,
              session.directory,
              topic?.threadId ?? null,
            ),
        });
      }
    }
  } finally {
    if (deliverPick && pickGeneration !== null) {
      releaseSessionPickHold(deps.summaryAggregator, pickGeneration);
    }
  }

  if (options.removeCallbackReplyMarkup) {
    await removeCallbackReplyMarkup(ctx);
  }

  if (options.deleteCallbackMessage) {
    await ctx.deleteMessage();
  }
}

function shouldBlockBackgroundSessionOpen(deps: SessionSelectDeps, scope: string): boolean {
  const activeInteraction = deps.interactionManager.getSnapshot(scope);
  return activeInteraction !== null && activeInteraction.kind !== "inline";
}

const BACKGROUND_PROJECT_SWITCH_REASON = "background_session_project_switched";
const BACKGROUND_OPEN_ROLLBACK_REASON = "background_session_open_rollback";

/** What the selection looked like before a notification moved it to another project. */
interface BackgroundOpenRollback {
  project: ProjectInfo;
  session: SessionInfo | undefined;
  agent: string;
  model: ModelInfo;
  tracker: BackgroundSessionTrackerSnapshot;
}

/**
 * The session a notification points at, read the way the selection reads it — in the selected
 * project's directory — so the answer carries the session's real directory and project. A session
 * the server does not return is an error rather than a reason to open it in the selected project.
 */
async function readNotifiedSession(sessionId: string, directory: string) {
  const { data, error } = await opencodeClient.session.get({ sessionID: sessionId, directory });
  if (error || !data) {
    throw error || new Error(`Session ${sessionId} was not returned for ${directory}`);
  }
  return data;
}

/** The project a session belongs to, recorded the way the recent-sessions menu records it. */
function projectOfSession(session: { projectID: string; directory: string }): ProjectInfo {
  return { id: session.projectID, worktree: session.directory, name: session.directory };
}

/**
 * Puts back what a failed open changed: the project, the agent and model the open pulled from its
 * session, the background tracking state the switch wiped and the session itself. A rollback that
 * fails leaves its trace in the log only — the user still gets the selection error.
 */
async function restoreSelectionAfterFailedOpen(
  ctx: Context,
  deps: BackgroundSessionOpenDeps,
  previous: BackgroundOpenRollback,
): Promise<void> {
  try {
    selectAgent(previous.agent);
    selectModel(previous.model);
    await switchToProject(ctx, previous.project, BACKGROUND_OPEN_ROLLBACK_REASON, {
      ...deps,
      presentation: createProjectSwitchPresentation(deps),
    });
    deps.backgroundSessionTracker.restore(previous.tracker);
    if (!previous.session || !ctx.chat) {
      return;
    }
    setCurrentSession(previous.session);
    await attachToSession({ ...deps, chatId: ctx.chat.id, session: previous.session });
  } catch (error) {
    logger.error(
      "[Sessions] Failed to restore the selection after a failed background open:",
      error,
    );
  }
}

export async function handleBackgroundSessionOpen(
  ctx: Context,
  deps: BackgroundSessionOpenDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return false;
  }

  const payload = parseBackgroundSessionCallback(data);
  if (!payload) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  if (shouldBlockBackgroundSessionOpen(deps, getInteractionScope(ctx))) {
    await ctx
      .answerCallbackQuery({ text: t("interaction.blocked.finish_current") })
      .catch(() => {});
    return true;
  }

  const previousProject = getCurrentProject();
  const previousSession = getCurrentSession();
  // An old notification outlives the project it was sent from: its session, not the selected
  // project, decides where the prompt runs, so the selection is moved to that project first.
  let rollback: BackgroundOpenRollback | null = null;

  try {
    if (previousProject) {
      const notified = await readNotifiedSession(payload.sessionId, previousProject.worktree);
      if (normalizePathKey(notified.directory) !== normalizePathKey(previousProject.worktree)) {
        logger.info(
          `[Sessions] Background session ${payload.sessionId} belongs to ${notified.directory}; switching from ${previousProject.worktree}`,
        );
        // The switch can fail halfway, after the project is written, so the rollback is armed first.
        rollback = {
          project: previousProject,
          session: previousSession,
          agent: getStoredAgent(),
          model: { ...getStoredModel() },
          tracker: deps.backgroundSessionTracker.snapshot(),
        };
        await switchToProject(ctx, projectOfSession(notified), BACKGROUND_PROJECT_SWITCH_REASON, {
          ...deps,
          presentation: createProjectSwitchPresentation(deps),
        });
      }
    }

    await selectSessionById(ctx, deps, payload.sessionId, {
      source: "background_notification",
      deleteCallbackMessage: false,
      removeCallbackReplyMarkup: true,
      postSelectAction:
        payload.kind === "assistant_response" ? "latest_assistant_response" : "none",
    });
  } catch (error) {
    logger.error("[Sessions] Error selecting background session:", error);
    if (rollback) {
      await restoreSelectionAfterFailedOpen(ctx, deps, rollback);
    }
    await ctx
      .answerCallbackQuery({ text: t("sessions.select_error"), show_alert: true })
      .catch(() => {});
  }

  return true;
}

export async function handleSessionSelect(ctx: Context, deps: SessionSelectDeps): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data || !callbackQuery.data.startsWith(SESSION_CALLBACK_PREFIX)) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  const page = parseSessionPageCallback(callbackQuery.data);
  const sessionId = parseSessionIdCallback(callbackQuery.data);

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "session", deps);
  if (!isActiveMenu) {
    return true;
  }

  try {
    const currentProject = getCurrentProject();

    if (!currentProject) {
      deps.resetInteractions("session_select_project_missing");
      await alert(ctx, "sessions.select_project_first");
      return true;
    }

    if (page !== null) {
      try {
        const pageSize = config.bot.sessionsListLimit;
        const pageData = await loadSessionPage(currentProject.worktree, page, pageSize);
        if (pageData.sessions.length === 0) {
          await ctx.answerCallbackQuery({ text: t("sessions.page_empty_callback") });
          return true;
        }

        const { text, keyboard } = buildSessionSelectionMenuView(pageData, pageSize);
        appendInlineMenuCancelButton(keyboard, "session");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, {
          reply_markup: keyboard,
        });
      } catch (error) {
        logger.error("[Sessions] Error loading sessions page:", error);
        await ctx.answerCallbackQuery({ text: t("sessions.page_load_error_callback") });
      }

      return true;
    }

    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
      return true;
    }

    await selectSessionById(ctx, deps, sessionId, {
      source: "menu",
      deleteCallbackMessage: true,
      removeCallbackReplyMarkup: false,
      postSelectAction: "preview",
    });
  } catch (error) {
    deps.resetInteractions("session_select_error");
    logger.error("[Sessions] Error selecting session:", error);
    await failure(ctx, "sessions.select_error");
  }

  return true;
}

function extractTextParts(
  parts: Array<{ type: string; text?: string }>,
  options: { trim?: boolean } = {},
): string | null {
  const textParts = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);

  if (textParts.length === 0) {
    return null;
  }

  const text = textParts.join("");
  const normalizedText = options.trim === false ? text : text.trim();
  return normalizedText.trim().length > 0 ? normalizedText : null;
}

function sessionPickSendGapMs(): number {
  return process.env.VITEST ? 0 : SESSION_PICK_SEND_GAP_MS;
}

function waitForSessionPickSend(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, sessionPickSendGapMs()));
}

/**
 * Releases the outbound hold in the background: the deferred live-stream updates are
 * replayed at a send gap, and awaiting that here would block grammY's sequential update
 * loop for as long as the picked session keeps streaming.
 */
function releaseSessionPickHold(
  aggregator: SessionSelectDeps["summaryAggregator"],
  generation: number,
): void {
  safeBackgroundTask({
    taskName: "sessions.releasePickOutbound",
    task: async () => {
      try {
        if (aggregator.hasDeferredOutbound()) {
          await waitForSessionPickSend();
        }
      } finally {
        await aggregator.drainOutbound(sessionPickSendGapMs(), generation);
      }
    },
  });
}

async function readSessionBusy(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory });
    if (error || !data) {
      logger.warn("[Sessions] Failed to read session status for pick:", error);
      return true;
    }
    return data[sessionId]?.type === "busy";
  } catch (err) {
    logger.warn("[Sessions] Failed to read session status for pick:", err);
    return true;
  }
}

async function loadSessionPickMessages(
  sessionId: string,
  directory: string,
  busy: boolean,
): Promise<SessionPickMessage[] | null> {
  const loaded: SessionPickMessage[] = [];
  const seen = new Set<string>();
  let before: string | undefined;

  try {
    for (;;) {
      const { data, error } = await opencodeClient.session.messages({
        sessionID: sessionId,
        directory,
        limit: SESSION_PICK_PAGE_SIZE,
        ...(before ? { before } : {}),
      });

      if (error || !data) {
        logger.warn("[Sessions] Failed to fetch session messages for pick:", error);
        // Keep the pages already loaded: a failing cursor must not turn a readable
        // transcript into "No recent messages".
        return loaded.length > 0 ? loaded : null;
      }

      const pageMessages = data as SessionPickMessage[];
      if (pageMessages.length === 0) {
        return loaded;
      }

      let added = 0;
      for (const message of pageMessages) {
        const id = message.info.id;
        if (id && seen.has(id)) {
          continue;
        }
        if (id) {
          seen.add(id);
        }
        loaded.push(message);
        added += 1;
      }

      if (added === 0 || findEligibleReply(loaded, busy)) {
        return loaded;
      }
      if (pageMessages.length < SESSION_PICK_PAGE_SIZE) {
        return loaded;
      }

      const oldest = pageMessages.reduce((current, message) => {
        const created = message.info.time?.created ?? 0;
        const currentCreated = current.info.time?.created ?? 0;
        return created < currentCreated ? message : current;
      });
      if (!oldest.info.id || oldest.info.id === before) {
        return loaded;
      }
      before = oldest.info.id;
    }
  } catch (err) {
    logger.error("[Sessions] Error loading session messages for pick:", err);
    return loaded.length > 0 ? loaded : null;
  }
}

async function loadParentMessage(
  sessionId: string,
  messageId: string,
  directory: string,
): Promise<SessionPickMessage | null> {
  try {
    const { data, error } = await opencodeClient.session.message({
      sessionID: sessionId,
      messageID: messageId,
      directory,
    });
    if (error || !data) {
      logger.warn("[Sessions] Failed to load the user message for the shown reply:", error);
      return null;
    }
    return data as SessionPickMessage;
  } catch (err) {
    logger.warn("[Sessions] Failed to load the user message for the shown reply:", err);
    return null;
  }
}

async function sendPickQuote(
  api: Context["api"],
  chatId: number,
  quote: QuotedNotification,
  threadId: number | null,
): Promise<void> {
  await waitForSessionPickSend();
  try {
    await sendBotText({
      api,
      chatId,
      text: quote.text,
      rawFallbackText: quote.rawFallbackText,
      format: "markdown_v2",
      options: topicSendOptions(threadId),
    });
  } catch (err) {
    logger.error("[Sessions] Failed to send the session pick quote:", err);
  }
}

async function sendSessionPickTranscript(
  api: Context["api"],
  chatId: number,
  sessionId: string,
  directory: string,
  messages: SessionPickMessage[] | null,
  busy: boolean,
  threadId: number | null,
): Promise<void> {
  const reply = messages ? findEligibleReply(messages, busy) : null;
  let quoteSource: SessionPickMessage | null = null;

  if (messages && reply?.parentId) {
    quoteSource = findMessageById(messages, reply.parentId);
    if (!quoteSource) {
      quoteSource = await loadParentMessage(sessionId, reply.parentId, directory);
    }
  } else if (messages && !reply) {
    quoteSource = findLatestUserPrompt(messages);
  }

  const quote = quoteSource ? buildSessionPickQuote(quoteSource) : null;
  if (quote) {
    await sendPickQuote(api, chatId, quote, threadId);
  } else if (!reply) {
    await waitForSessionPickSend();
    try {
      await api.sendMessage(chatId, t("sessions.preview.empty"), topicSendOptions(threadId));
    } catch (err) {
      logger.error("[Sessions] Failed to send the empty session notice:", err);
    }
  }

  if (!reply) {
    return;
  }

  const prepared = await prepareAssistantDocuments(
    reply.text,
    directory,
    () => getCurrentSession()?.id === sessionId,
  );
  const parts = renderAssistantFinalPartsSafe(
    prepared.text,
    directory,
    () => getCurrentSession()?.id === sessionId,
  );
  for (const part of parts) {
    await waitForSessionPickSend();
    await sendRenderedBotPart({
      api,
      chatId,
      part,
      options: { ...AGENT_TEXT_LINK_PREVIEW_OPTIONS, ...topicSendOptions(threadId) },
    });
  }
  if (reply.completed !== undefined)
    await deliverAssistantDocuments(prepared, api, chatId, { disable_notification: true });

  // The reply is in the chat now: its session stops carrying the unread mark. A send that threw
  // above leaves the mark where it was, and so does a reply that has not finished yet.
  if (reply.completed !== undefined) {
    markSessionReplyRead(sessionId, reply.completed);
  }

  // A message sent after the shown reply started is still waiting for its own reply: show it
  // too, so the picked session does not look like the message never went through.
  const pendingPrompt = messages ? findPendingUserPrompt(messages, reply.created) : null;
  const pendingQuote = pendingPrompt ? buildSessionPickQuote(pendingPrompt) : null;
  if (pendingQuote) {
    await sendPickQuote(api, chatId, pendingQuote, threadId);
  }
}

async function loadLatestAssistantResponse(
  sessionId: string,
  directory: string,
): Promise<{ text: string; shownAt: number | null } | null> {
  try {
    const { data: messages, error } = await opencodeClient.session.messages({
      sessionID: sessionId,
      directory,
      limit: LATEST_ASSISTANT_RESPONSE_MESSAGES_LIMIT,
    });

    if (error || !messages) {
      logger.warn("[Sessions] Failed to fetch latest assistant response:", error);
      return null;
    }

    const latestResponse = (messages as SessionMessageLike[]).reduce<{
      text: string;
      created: number;
      completedAt?: number | undefined;
      errored: boolean;
    } | null>((latest, message) => {
      if (message.info.role !== "assistant" || message.info.summary) {
        return latest;
      }

      const text = extractTextParts(message.parts, { trim: false });
      if (!text) {
        return latest;
      }

      const created = message.info.time?.created ?? 0;
      if (!latest || created >= latest.created) {
        return {
          text,
          created,
          completedAt: message.info.time?.completed,
          errored: Boolean(message.info.error),
        };
      }

      return latest;
    }, null);

    if (!latestResponse) {
      return null;
    }

    // Only a finished, successful reply is the reply a mark is about. One that failed or is still
    // streaming is shown as it is, and clears nothing.
    return {
      text: latestResponse.text,
      shownAt: latestResponse.errored ? null : (latestResponse.completedAt ?? null),
    };
  } catch (err) {
    logger.error("[Sessions] Error loading latest assistant response:", err);
    return null;
  }
}

async function sendLatestAssistantResponse(
  api: Context["api"],
  chatId: number,
  sessionId: string,
  directory: string,
  threadId: number | null,
): Promise<void> {
  const response = await loadLatestAssistantResponse(sessionId, directory);
  if (!response) {
    return;
  }

  const prepared = await prepareAssistantDocuments(
    response.text,
    directory,
    () => getCurrentSession()?.id === sessionId,
  );
  const parts = renderAssistantFinalPartsSafe(
    prepared.text,
    directory,
    () => getCurrentSession()?.id === sessionId,
  );
  for (const part of parts) {
    await sendRenderedBotPart({
      api,
      chatId,
      part,
      options: { ...AGENT_TEXT_LINK_PREVIEW_OPTIONS, ...topicSendOptions(threadId) },
    });
  }
  if (response.shownAt !== null)
    await deliverAssistantDocuments(prepared, api, chatId, { disable_notification: true });

  // The notification showed the reply itself, so the session stops carrying its mark; a failed
  // send threw above and leaves the mark standing.
  if (response.shownAt !== null) {
    markSessionReplyRead(sessionId, response.shownAt);
  }
}
