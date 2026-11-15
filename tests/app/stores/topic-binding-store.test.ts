import path from "node:path";
import { readFile, rm } from "node:fs/promises";
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
  getTopicBindingBySession,
  listTopicBindings,
  registerTopicBinding,
  removeTopicBinding,
} from "../../../src/app/stores/topic-binding-store.js";
import type { TopicSessionBinding } from "../../../src/app/types/topics.js";

describe("app/stores/topic-binding-store", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await createTestHome("opencode-telegram-topic-binding-");
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
    await rm(tempHome, { recursive: true, force: true });
  });

  it("registers a new binding and reads it back by chatId/threadId", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
    });

    const binding = getTopicBinding(100, 42);
    expect(binding).toMatchObject({
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
    });
    expect(typeof binding?.createdAt).toBe("string");
  });

  it("finds a binding by sessionId for reconnection", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
    });

    const entry = getTopicBindingBySession("session-1");
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      chatId: 100,
      threadId: 42,
      binding: { sessionId: "session-1", topicName: "Feature work" },
    });
    expect(getTopicBindingBySession("missing-session")).toBeNull();
  });

  it("overwrites an existing binding under the same key without duplicating it", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
    });
    const first = getTopicBinding(100, 42);

    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-2",
      directory: "D:/Projects/Repo",
      topicName: "Feature work renamed",
    });

    expect(listTopicBindings()).toHaveLength(1);
    expect(getTopicBinding(100, 42)).toMatchObject({
      sessionId: "session-2",
      topicName: "Feature work renamed",
    });
    expect(getTopicBinding(100, 42)?.createdAt).toBe(first?.createdAt);
  });

  it("removes a binding", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
    });

    expect(await removeTopicBinding(100, 42)).toBe(true);

    expect(getTopicBinding(100, 42)).toBeNull();
    expect(listTopicBindings()).toHaveLength(0);
    expect(await removeTopicBinding(100, 42)).toBe(false);
  });

  it("moves a session to a new thread instead of duplicating it", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Original topic",
    });

    await registerTopicBinding({
      chatId: 100,
      threadId: 77,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Renamed topic",
    });

    expect(listTopicBindings()).toHaveLength(1);
    expect(getTopicBinding(100, 42)).toBeNull();
    expect(getTopicBindingBySession("session-1")).toMatchObject({
      chatId: 100,
      threadId: 77,
      binding: { sessionId: "session-1", topicName: "Renamed topic" },
    });
  });

  it("re-binding one session does not remove another session's binding", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 1,
      sessionId: "session-1",
      directory: "D:/Projects/One",
      topicName: "Topic one",
    });
    await registerTopicBinding({
      chatId: 100,
      threadId: 2,
      sessionId: "session-2",
      directory: "D:/Projects/Two",
      topicName: "Topic two",
    });

    await registerTopicBinding({
      chatId: 100,
      threadId: 3,
      sessionId: "session-1",
      directory: "D:/Projects/One",
      topicName: "Topic one moved",
    });

    expect(listTopicBindings()).toHaveLength(2);
    expect(getTopicBindingBySession("session-1")).toMatchObject({ threadId: 3 });
    expect(getTopicBindingBySession("session-2")).toMatchObject({ threadId: 2 });
  });

  it("re-registering the same key does not duplicate the entry or reset createdAt", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
    });
    const createdAt = getTopicBinding(100, 42)?.createdAt;

    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work again",
    });

    expect(listTopicBindings()).toHaveLength(1);
    expect(getTopicBinding(100, 42)).toMatchObject({ topicName: "Feature work again" });
    expect(getTopicBinding(100, 42)?.createdAt).toBe(createdAt);
  });

  it("keeps two topics in two chats isolated", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 1,
      sessionId: "session-1",
      directory: "D:/Projects/One",
      topicName: "Topic one",
    });
    await registerTopicBinding({
      chatId: 200,
      threadId: 2,
      sessionId: "session-2",
      directory: "D:/Projects/Two",
      topicName: "Topic two",
    });

    expect(getTopicBinding(100, 1)).toMatchObject({ sessionId: "session-1" });
    expect(getTopicBinding(200, 2)).toMatchObject({ sessionId: "session-2" });
    expect(getTopicBinding(100, 2)).toBeNull();

    expect(getTopicBindingBySession("session-1")).toMatchObject({ chatId: 100, threadId: 1 });
    expect(getTopicBindingBySession("session-2")).toMatchObject({ chatId: 200, threadId: 2 });
    expect(listTopicBindings()).toHaveLength(2);
  });

  it("persists bindings to settings.json", async () => {
    await registerTopicBinding({
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
    });

    const settingsPath = path.join(tempHome, "settings.json");
    const settingsFile = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      topicSessionBindings?: Record<string, TopicSessionBinding>;
    };

    expect(settingsFile.topicSessionBindings?.["100:42"]).toMatchObject({
      sessionId: "session-1",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
    });
  });
});
