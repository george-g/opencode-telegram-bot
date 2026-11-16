import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHome } from "../../helpers/test-environment.js";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import {
  __resetSettingsForTests,
  flushSettings,
  loadSettings,
} from "../../../src/app/stores/settings-store.js";
import {
  __resetTopicBindingStoreForTests,
  getTopicBinding,
  registerTopicBinding,
} from "../../../src/app/stores/topic-binding-store.js";
import {
  __resetDeadTopicLatchesForTests,
  dropDeadTopicBinding,
} from "../../../src/bot/events/topic-binding-recovery.js";

/** The `400` Telegram answers with for a forum topic that no longer exists. */
function topicNotFoundError(): Error {
  return Object.assign(new Error("Call to 'sendMessage' failed! (400: message thread not found)"), {
    error_code: 400,
    description: "Bad Request: message thread not found",
  });
}

describe("bot/events/topic-binding-recovery", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await createTestHome("opencode-telegram-topic-recovery-");
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", tempHome);
    setRuntimeMode("installed");
    __resetSettingsForTests();
    __resetTopicBindingStoreForTests();
    __resetDeadTopicLatchesForTests();
    await loadSettings();

    await registerTopicBinding({
      chatId: 100,
      threadId: 19,
      sessionId: "session-1",
      directory: "D:/repo",
      topicName: "Session 1 · repo",
    });
  });

  afterEach(async () => {
    await flushSettings();
    __resetSettingsForTests();
    __resetTopicBindingStoreForTests();
    __resetDeadTopicLatchesForTests();
    vi.unstubAllEnvs();
    await rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("removes the binding of a deleted topic", async () => {
    expect(await dropDeadTopicBinding(100, 19, topicNotFoundError())).toBe(true);
    expect(getTopicBinding(100, 19)).toBeNull();
  });

  it("ignores every failure that is not a deleted topic", async () => {
    const otherError = Object.assign(new Error("Bad Request: chat not found"), { error_code: 400 });

    expect(await dropDeadTopicBinding(100, 19, otherError)).toBe(false);
    expect(getTopicBinding(100, 19)).not.toBeNull();
  });

  it("marks the topic dead so the same burst removes the binding once", async () => {
    expect(await dropDeadTopicBinding(100, 19, topicNotFoundError())).toBe(true);
    // The next send of the same burst finds the topic still marked: no second removal.
    expect(await dropDeadTopicBinding(100, 19, topicNotFoundError())).toBe(false);
    expect(getTopicBinding(100, 19)).toBeNull();
  });

  it("keeps the mark per topic, so another topic is still cleaned up", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 55,
      sessionId: "session-2",
      directory: "D:/repo",
      topicName: "Session 2 · repo",
    });

    expect(await dropDeadTopicBinding(100, 19, topicNotFoundError())).toBe(true);
    expect(await dropDeadTopicBinding(100, 55, topicNotFoundError())).toBe(true);
    expect(getTopicBinding(100, 19)).toBeNull();
    expect(getTopicBinding(100, 55)).toBeNull();
  });
});
