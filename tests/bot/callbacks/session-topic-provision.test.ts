import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { selectSessionById, type SessionSelectDeps } from "../../../src/bot/callbacks/session-callback-handler.js";
import { t } from "../../../src/i18n/index.js";

interface StoredBinding {
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  topicName: string;
  createdAt: string;
}

const mocked = vi.hoisted(() => {
  const bindings = new Map<string, StoredBinding>();

  return {
    bindings,
    getTopicBindingBySession: vi.fn((sessionId: string) => {
      for (const binding of bindings.values()) {
        if (binding.sessionId === sessionId) {
          const { chatId, threadId, ...rest } = binding;
          return { chatId, threadId, binding: rest };
        }
      }
      return null;
    }),
    registerTopicBinding: vi.fn(async (input: Omit<StoredBinding, "createdAt">) => {
      bindings.set(`${input.chatId}:${input.threadId}`, {
        ...input,
        createdAt: new Date().toISOString(),
      });
    }),
    removeTopicBinding: vi.fn(async (chatId: number, threadId: number) =>
      bindings.delete(`${chatId}:${threadId}`),
    ),
    getSession: vi.fn(),
    status: vi.fn(),
    messages: vi.fn(),
    message: vi.fn(),
    setCurrentSession: vi.fn(),
    applySessionSettings: vi.fn(),
    attachToSession: vi.fn(),
    resolveProjectAgent: vi.fn(),
    getStoredModel: vi.fn(),
    getCurrentProject: vi.fn(),
    resetInteractions: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      get: mocked.getSession,
      status: mocked.status,
      messages: mocked.messages,
      message: mocked.message,
    },
  },
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: () => mocked.getCurrentProject(),
  getCurrentSession: () => undefined,
}));
vi.mock("../../../src/app/stores/topic-binding-store.js", () => ({
  getTopicBindingBySession: mocked.getTopicBindingBySession,
  registerTopicBinding: mocked.registerTopicBinding,
  removeTopicBinding: mocked.removeTopicBinding,
}));
vi.mock("../../../src/app/services/session-service.js", () => ({
  setCurrentSession: mocked.setCurrentSession,
}));
vi.mock("../../../src/app/services/session-settings-service.js", () => ({
  applySessionSettings: mocked.applySessionSettings,
}));
vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: () => "build",
  resolveProjectAgent: mocked.resolveProjectAgent,
  selectAgent: vi.fn(),
}));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModel,
  selectModel: vi.fn(),
}));
vi.mock("../../../src/app/services/attach-service.js", () => ({
  attachToSession: mocked.attachToSession,
}));
vi.mock("../../../src/app/services/run-control-service.js", () => ({
  isForegroundBusy: () => false,
}));
vi.mock("../../../src/bot/messages/telegram-text.js", () => ({
  AGENT_TEXT_LINK_PREVIEW_OPTIONS: {},
  sendBotText: vi.fn(),
  sendRenderedBotPart: vi.fn(),
}));
vi.mock("../../../src/bot/messages/assistant-rendering.js", () => ({
  renderAssistantFinalPartsSafe: (text: string) => [{ text }],
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocked.warn, error: mocked.error },
}));

function createSession(index: number) {
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
    directory: "/repo",
    projectID: "p1",
  };
}

interface ContextOptions {
  chatType?: string;
  createForumTopic?: (chatId: number, name: string) => Promise<{ message_thread_id: number }>;
}

function context(options: ContextOptions = {}) {
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
    deleteMessage: vi.fn().mockResolvedValue(true),
    createForumTopic: vi.fn(
      options.createForumTopic ??
        (async () => ({ message_thread_id: 500 })),
    ),
  };
  return {
    chat: { id: 111, type: options.chatType ?? "supergroup" },
    api,
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
  } as unknown as Context & { api: typeof api };
}

function deps(): SessionSelectDeps {
  return {
    bot: {} as SessionSelectDeps["bot"],
    attachManager: {} as SessionSelectDeps["attachManager"],
    ensureEventSubscription: vi.fn(),
    foregroundSessionState: {} as SessionSelectDeps["foregroundSessionState"],
    interactionManager: {} as SessionSelectDeps["interactionManager"],
    permissionManager: {} as SessionSelectDeps["permissionManager"],
    questionManager: {} as SessionSelectDeps["questionManager"],
    resetInteractions: mocked.resetInteractions,
    pinnedMessageManager: {
      getState: () => ({ sessionId: null, messageId: null }),
      onModelChange: vi.fn(),
    } as unknown as SessionSelectDeps["pinnedMessageManager"],
    keyboardManager: {
      updateAgent: vi.fn(),
      updateModel: vi.fn(),
      getContextInfo: () => undefined,
      updateContext: vi.fn(),
      getKeyboard: () => undefined,
    } as unknown as SessionSelectDeps["keyboardManager"],
    summaryAggregator: {} as SessionSelectDeps["summaryAggregator"],
  };
}

const selectionOptions = {
  source: "menu" as const,
  deleteCallbackMessage: false,
  removeCallbackReplyMarkup: false,
  postSelectAction: "none" as const,
};

describe("bot/callbacks/session-topic-provision", () => {
  beforeEach(() => {
    mocked.bindings.clear();
    mocked.getTopicBindingBySession.mockClear();
    mocked.registerTopicBinding.mockClear();
    mocked.removeTopicBinding.mockClear();
    mocked.getSession.mockReset();
    mocked.status.mockReset().mockResolvedValue({ data: {}, error: null });
    mocked.messages.mockReset().mockResolvedValue({ data: [], error: null });
    mocked.message.mockReset().mockResolvedValue({ data: null, error: null });
    mocked.setCurrentSession.mockReset();
    mocked.applySessionSettings.mockReset().mockResolvedValue(false);
    mocked.attachToSession.mockReset().mockResolvedValue({
      busy: false,
      alreadyAttached: false,
      restoredQuestion: false,
      restoredPermissions: 0,
    });
    mocked.resolveProjectAgent.mockReset().mockResolvedValue("build");
    mocked.getStoredModel.mockReset().mockReturnValue({ providerID: "p", modelID: "m" });
    mocked.getCurrentProject
      .mockReset()
      .mockReturnValue({ id: "p1", worktree: "/repo", name: "repo" });
    mocked.resetInteractions.mockReset();
  });

  it("creates a topic and saves the binding when the session has none", async () => {
    mocked.getSession.mockResolvedValue({ data: createSession(1), error: null });
    const ctx = context();

    await selectSessionById(ctx, deps(), "session-1", selectionOptions);

    expect(ctx.api.createForumTopic).toHaveBeenCalledTimes(1);
    expect(ctx.api.createForumTopic).toHaveBeenCalledWith(111, "Session 1 · repo");
    expect(mocked.registerTopicBinding).toHaveBeenCalledTimes(1);
    expect(mocked.registerTopicBinding).toHaveBeenCalledWith({
      chatId: 111,
      threadId: 500,
      sessionId: "session-1",
      directory: "/repo",
      topicName: "Session 1 · repo",
    });
    expect(mocked.bindings.get("111:500")).toMatchObject({
      sessionId: "session-1",
      threadId: 500,
    });
    // The loading notice opens the topic; no selection notice exists.
    const sentTexts = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[1]),
    );
    expect(sentTexts).toContain(t("sessions.loading_context"));
    expect(sentTexts.some((text) => text.includes("sessions.selected"))).toBe(false);
    const loadingSend = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => String(call[1]) === t("sessions.loading_context"),
    );
    expect(loadingSend?.[2]).toMatchObject({ message_thread_id: 500 });
  });

  it("reuses the existing topic without creating a duplicate on re-connect", async () => {
    mocked.getSession.mockResolvedValue({ data: createSession(1), error: null });

    const first = context();
    await selectSessionById(first, deps(), "session-1", selectionOptions);
    expect(first.api.createForumTopic).toHaveBeenCalledTimes(1);

    const second = context();
    await selectSessionById(second, deps(), "session-1", selectionOptions);

    expect(second.api.createForumTopic).not.toHaveBeenCalled();
    expect(mocked.registerTopicBinding).toHaveBeenCalledTimes(1);
    expect(mocked.getTopicBindingBySession).toHaveBeenCalledWith("session-1");

    // The connection notice goes into the reused topic, not the chat root.
    const topicSend = (second.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[2] as { message_thread_id?: number } | undefined)?.message_thread_id === 500,
    );
    expect(topicSend?.[0]).toBe(111);
  });

  it("gives two sessions two separate topics with non-overlapping bindings", async () => {
    mocked.getSession
      .mockResolvedValueOnce({ data: createSession(1), error: null })
      .mockResolvedValueOnce({ data: createSession(2), error: null });
    let nextThreadId = 500;
    const makeContext = () =>
      context({
        createForumTopic: async () => ({ message_thread_id: nextThreadId++ }),
      });

    await selectSessionById(makeContext(), deps(), "session-1", selectionOptions);
    await selectSessionById(makeContext(), deps(), "session-2", selectionOptions);

    expect(mocked.registerTopicBinding).toHaveBeenCalledTimes(2);
    const threadIds = [...mocked.bindings.values()].map((binding) => binding.threadId);
    expect(new Set(threadIds).size).toBe(2);
    expect(mocked.bindings.get("111:500")).toMatchObject({ sessionId: "session-1" });
    expect(mocked.bindings.get("111:501")).toMatchObject({ sessionId: "session-2" });
    expect(mocked.getTopicBindingBySession("session-1")).toMatchObject({ threadId: 500 });
    expect(mocked.getTopicBindingBySession("session-2")).toMatchObject({ threadId: 501 });
  });

  it("keeps the attach going and tells the user when the topic cannot be created", async () => {
    mocked.getSession.mockResolvedValue({ data: createSession(1), error: null });
    const ctx = context({
      createForumTopic: async () => {
        throw new Error("Bad Request: not enough rights to manage topics");
      },
    });

    await expect(
      selectSessionById(ctx, deps(), "session-1", selectionOptions),
    ).resolves.toBeUndefined();

    expect(mocked.attachToSession).toHaveBeenCalledTimes(1);
    expect(mocked.setCurrentSession).toHaveBeenCalledWith({
      id: "session-1",
      title: "Session 1",
      directory: "/repo",
    });
    expect(mocked.registerTopicBinding).not.toHaveBeenCalled();
    expect(mocked.error).toHaveBeenCalled();
    const sentTexts = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[1]),
    );
    expect(sentTexts).toContain(t("sessions.topic_create_failed"));
    // The loading notice still goes out; the selection never announces itself.
    expect(sentTexts).toContain(t("sessions.loading_context"));
    expect(sentTexts.some((text) => text.includes("sessions.selected"))).toBe(false);
  });

  it("leaves the chat untouched when it cannot hold topics", async () => {
    mocked.getSession.mockResolvedValue({ data: createSession(1), error: null });
    const ctx = context({ chatType: "private" });

    await selectSessionById(ctx, deps(), "session-1", selectionOptions);

    expect(ctx.api.createForumTopic).not.toHaveBeenCalled();
    expect(mocked.registerTopicBinding).not.toHaveBeenCalled();
    expect(mocked.getTopicBindingBySession).not.toHaveBeenCalled();
  });

  it("drops the topic binding after a failed attach and passes the error on", async () => {
    mocked.getSession.mockResolvedValue({ data: createSession(1), error: null });
    const err = new Error("attach failed");
    mocked.attachToSession.mockRejectedValueOnce(err);
    const ctx = context();

    await expect(selectSessionById(ctx, deps(), "session-1", selectionOptions)).rejects.toBe(err);

    // The topic exists but the session never followed: the binding must not survive.
    expect(mocked.registerTopicBinding).toHaveBeenCalledTimes(1);
    expect(mocked.removeTopicBinding).toHaveBeenCalledTimes(1);
    expect(mocked.removeTopicBinding).toHaveBeenCalledWith(111, 500);
    // In a topic the loading notice stays as the first message, so it is not deleted.
    expect(ctx.api.deleteMessage).not.toHaveBeenCalled();
    // The topic itself stays in the chat: the topic API has no delete call here.
    expect((ctx.api as unknown as Record<string, unknown>).deleteForumTopic).toBeUndefined();
  });
});
