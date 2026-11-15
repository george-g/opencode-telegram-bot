import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";

const mocked = vi.hoisted(() => ({
  getTopicBindingMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock("../../../src/app/stores/topic-binding-store.js", () => ({
  getTopicBinding: mocked.getTopicBindingMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getTopicScope,
  getMessageThreadId,
  setTopicScope,
  topicScopeMiddleware,
} from "../../../src/bot/middleware/topic-scope.js";

function createMessageContext(chatId: number, threadId?: number): Context {
  return {
    chat: { id: chatId },
    message: {
      message_id: 1,
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    } as Context["message"],
  } as unknown as Context;
}

function createCallbackContext(chatId: number, threadId?: number): Context {
  return {
    chat: { id: chatId },
    callbackQuery: {
      id: "cb-1",
      data: "session:select",
      message: {
        message_id: 2,
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      },
    } as unknown as Context["callbackQuery"],
  } as unknown as Context;
}

describe("bot/middleware/topic-scope", () => {
  beforeEach(() => {
    mocked.getTopicBindingMock.mockReset();
    mocked.getTopicBindingMock.mockReturnValue(null);
  });

  it("sets the session scope for a message in a bound topic", async () => {
    mocked.getTopicBindingMock.mockReturnValue({
      sessionId: "session-42",
      directory: "D:/Projects/Repo",
      topicName: "Feature work",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const ctx = createMessageContext(100, 42);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await topicScopeMiddleware(ctx, next);

    expect(mocked.getTopicBindingMock).toHaveBeenCalledWith(100, 42);
    expect(getTopicScope(ctx)).toEqual({
      sessionId: "session-42",
      directory: "D:/Projects/Repo",
      title: "Feature work",
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves the scope unset for a message in an unbound topic", async () => {
    mocked.getTopicBindingMock.mockReturnValue(null);
    const ctx = createMessageContext(100, 42);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await topicScopeMiddleware(ctx, next);

    expect(getTopicScope(ctx)).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves the scope unset for a General message without a thread", async () => {
    const ctx = createMessageContext(100);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await topicScopeMiddleware(ctx, next);

    expect(mocked.getTopicBindingMock).not.toHaveBeenCalled();
    expect(getTopicScope(ctx)).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("resolves the session for a callback from a bound topic", async () => {
    mocked.getTopicBindingMock.mockReturnValue({
      sessionId: "session-99",
      directory: "D:/Projects/Other",
      topicName: "Bugfix",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const ctx = createCallbackContext(100, 7);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await topicScopeMiddleware(ctx, next);

    expect(mocked.getTopicBindingMock).toHaveBeenCalledWith(100, 7);
    expect(getTopicScope(ctx)).toEqual({
      sessionId: "session-99",
      directory: "D:/Projects/Other",
      title: "Bugfix",
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves the scope unset for a callback without a thread", async () => {
    const ctx = createCallbackContext(100);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await topicScopeMiddleware(ctx, next);

    expect(mocked.getTopicBindingMock).not.toHaveBeenCalled();
    expect(getTopicScope(ctx)).toBeNull();
  });

  it("reads the thread id only from the message or the callback message", () => {
    expect(getMessageThreadId(createMessageContext(1, 5))).toBe(5);
    expect(getMessageThreadId(createMessageContext(1))).toBeNull();
    expect(getMessageThreadId(createCallbackContext(1, 9))).toBe(9);
    expect(getMessageThreadId(createCallbackContext(1))).toBeNull();
  });

  it("stores the scope on the context itself, not on a session object", () => {
    const ctx = createMessageContext(1);
    setTopicScope(ctx, { sessionId: "s", directory: "d", title: "t" });

    expect(getTopicScope(ctx)).toEqual({ sessionId: "s", directory: "d", title: "t" });
  });
});
