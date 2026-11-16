import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { createTestHome } from "../helpers/test-environment.js";
import { setRuntimeMode } from "../../src/runtime/mode.js";
import { createTestAppContainer } from "../helpers/app-container.js";
import {
  __resetSettingsForTests,
  flushSettings,
  loadSettings,
} from "../../src/app/stores/settings-store.js";
import {
  __resetTopicBindingStoreForTests,
  getTopicBindingBySession,
  listTopicBindings,
  registerTopicBinding,
} from "../../src/app/stores/topic-binding-store.js";

type FakeBotApi = {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  sendDocument: ReturnType<typeof vi.fn>;
  createForumTopic: ReturnType<typeof vi.fn>;
};

function createFakeBot(): { bot: Bot<Context>; api: FakeBotApi } {
  let nextMessageId = 100;
  const api: FakeBotApi = {
    sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 101 }),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 999 }),
  };
  return { bot: { api } as unknown as Bot<Context>, api };
}

interface PolicyView {
  isForegroundSession(sessionId: string): boolean;
  getDestination(sessionId: string): {
    api: unknown;
    chatId: number;
    messageThreadId?: number;
  } | null;
}

/**
 * The service keeps `policy` private; this is the documented test seam used by
 * tests/bot/services/event-subscription-service.test.ts.
 */
function readPolicy(service: unknown): PolicyView {
  return (service as { policy: PolicyView }).policy;
}

describe("spike-a1/delivery-and-gate", () => {
  let tempHome: string;
  let service: unknown;

  beforeEach(async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-telegram-token");
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "123456789");
    vi.stubEnv("OPENCODE_MODEL_PROVIDER", "test-provider");
    vi.stubEnv("OPENCODE_MODEL_ID", "test-model");
    tempHome = await createTestHome("spike-a1-");
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", tempHome);
    setRuntimeMode("installed");
    __resetSettingsForTests();
    __resetTopicBindingStoreForTests();
    await loadSettings();
  });

  afterEach(async () => {
    await flushSettings();
    __resetSettingsForTests();
    __resetTopicBindingStoreForTests();
    vi.unstubAllEnvs();
    await rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function setupService(): Promise<{ api: FakeBotApi; policy: PolicyView }> {
    const { createEventSubscriptionService } = await import(
      "../../src/bot/services/event-subscription-service.js"
    );
    const { bot, api } = createFakeBot();
    const container = createTestAppContainer();
    service = createEventSubscriptionService(container);
    (service as { setTelegramContext(bot: Bot<Context>, chatId: number): void }).setTelegramContext(
      bot,
      42,
    );

    return { api, policy: readPolicy(service) };
  }

  it("E2E: two topics in one chat are both foreground and route to their own thread", async () => {
    const { policy } = await setupService();

    await registerTopicBinding({
      chatId: 500,
      threadId: 101,
      sessionId: "A",
      directory: "D:/repo-a",
      topicName: "Topic A",
    });
    await registerTopicBinding({
      chatId: 500,
      threadId: 202,
      sessionId: "B",
      directory: "D:/repo-b",
      topicName: "Topic B",
    });

    // Gate (goal A1): a topic-bound session is foreground even when it is not current.
    expect(policy.isForegroundSession("A")).toBe(true);
    expect(policy.isForegroundSession("B")).toBe(true);

    const destA = policy.getDestination("A");
    const destB = policy.getDestination("B");
    expect(destA).not.toBeNull();
    expect(destB).not.toBeNull();
    expect(destA?.messageThreadId).toBe(101);
    expect(destB?.messageThreadId).toBe(202);
    // Same chat, different topics.
    expect(destA?.chatId).toBe(500);
    expect(destA?.chatId).toBe(destB?.chatId);

    // Also assert the store agrees, so a policy/store divergence is caught.
    expect(getTopicBindingBySession("A")).toMatchObject({ chatId: 500, threadId: 101 });
    expect(getTopicBindingBySession("B")).toMatchObject({ chatId: 500, threadId: 202 });
  });

  it("live delivery puts the bound session's message_thread_id on the send", async () => {
    const { api, policy } = await setupService();
    const { TelegramEventDelivery } = await import(
      "../../src/bot/events/telegram-event-delivery.js"
    );

    await registerTopicBinding({
      chatId: 500,
      threadId: 101,
      sessionId: "A",
      directory: "D:/repo-a",
      topicName: "Topic A",
    });

    const destination = policy.getDestination("A");
    expect(destination).not.toBeNull();

    const delivery = new TelegramEventDelivery();
    await delivery.sendText(destination as never, "hello");

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = api.sendMessage.mock.calls[0] as [
      number,
      string,
      { message_thread_id?: number },
    ];
    expect(chatId).toBe(500);
    expect(text).toBe("hello");
    expect(options?.message_thread_id).toBe(101);
  });

  it("backward compat: an unbound non-current session is not foreground and sends with no thread", async () => {
    const { policy } = await setupService();

    expect(policy.isForegroundSession("C")).toBe(false);

    const destC = policy.getDestination("C");
    expect(destC).not.toBeNull();
    expect(destC?.chatId).toBe(42);
    expect(destC?.messageThreadId).toBeUndefined();
  });

  it("an unbound current session is foreground", async () => {
    const { policy } = await setupService();
    const { setCurrentSession } = await import("../../src/app/services/session-service.js");

    setCurrentSession({ id: "A", title: "Current", directory: "D:/repo-a" });

    expect(policy.isForegroundSession("A")).toBe(true);
    const destA = policy.getDestination("A");
    expect(destA?.chatId).toBe(42);
    expect(destA?.messageThreadId).toBeUndefined();
  });

  it("idempotency: re-binding a session to a new topic replaces the old binding", async () => {
    await registerTopicBinding({
      chatId: 500,
      threadId: 101,
      sessionId: "A",
      directory: "D:/repo-a",
      topicName: "Topic A",
    });
    await registerTopicBinding({
      chatId: 500,
      threadId: 303,
      sessionId: "A",
      directory: "D:/repo-a",
      topicName: "Topic A renamed",
    });

    // Invariant: one session maps to exactly one topic. Re-binding session A to a
    // new thread replaces its previous binding instead of duplicating it, so only
    // the newest binding remains.
    expect(listTopicBindings()).toHaveLength(1);
    expect(getTopicBindingBySession("A")?.threadId).toBe(303);

    // The replaced thread is gone and the new binding is the only candidate.
    expect(listTopicBindings().filter((entry) => entry.binding.sessionId === "A")).toHaveLength(1);
    expect(listTopicBindings()[0]?.threadId).toBe(303);
  });

  it("A3: a 400 message thread not found on delivery drops the binding and creates nothing", async () => {
    const { api, policy } = await setupService();
    const { TelegramEventDelivery } = await import(
      "../../src/bot/events/telegram-event-delivery.js"
    );

    await registerTopicBinding({
      chatId: 500,
      threadId: 101,
      sessionId: "A",
      directory: "D:/repo-a",
      topicName: "Topic A",
    });

    const deadTopic = Object.assign(
      new Error("Call to 'sendMessage' failed! (400: message thread not found)"),
      { error_code: 400, description: "Bad Request: message thread not found" },
    );
    api.sendMessage.mockRejectedValueOnce(deadTopic);

    const destination = policy.getDestination("A");
    expect(destination?.messageThreadId).toBe(101);

    await expect(
      new TelegramEventDelivery().sendText(destination as never, "hello"),
    ).rejects.toBe(deadTopic);

    // The stale binding is gone: delivery never creates a topic, it only stops.
    expect(getTopicBindingBySession("A")).toBeNull();
    expect(api.createForumTopic).not.toHaveBeenCalled();

    // After the removal the session falls back to the plain chat on the next read.
    const fallback = policy.getDestination("A");
    expect(fallback?.chatId).toBe(42);
    expect(fallback?.messageThreadId).toBeUndefined();
  });
});
