import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { resolveInteractionGuardDecision } from "../../../src/bot/middleware/interaction-guard-decision.js";
import { getInteractionScope } from "../../../src/bot/middleware/interaction-scope.js";
import { startInteractionForTest } from "../../helpers/interaction.js";
import { createTestAppContainer } from "../../helpers/app-container.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";

let deps: AppContainer;

const CHAT_ID = 100;
const TOPIC_A = 42;
const TOPIC_B = 43;
const SCOPE_A = `${CHAT_ID}:${TOPIC_A}`;
const SCOPE_B = `${CHAT_ID}:${TOPIC_B}`;

/** A text update in the given topic; no thread id means the General topic. */
function textIn(threadId: number | undefined, text: string): Context {
  return {
    chat: { id: CHAT_ID },
    message: {
      message_id: 1,
      text,
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    } as Context["message"],
  } as unknown as Context;
}

/** A callback update on a message in the given topic. */
function callbackIn(threadId: number | undefined, data: string): Context {
  return {
    chat: { id: CHAT_ID },
    callbackQuery: {
      id: "cb-1",
      data,
      message: {
        message_id: 2,
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      },
    } as unknown as Context["callbackQuery"],
  } as unknown as Context;
}

beforeEach(() => {
  deps = createTestAppContainer();
});

describe("getInteractionScope", () => {
  it("reads a numbered topic from a message", () => {
    expect(getInteractionScope(textIn(TOPIC_A, "hello"))).toBe(SCOPE_A);
  });

  it("normalizes General and a non-forum chat to the no-thread key", () => {
    expect(getInteractionScope(textIn(undefined, "hello"))).toBe(`${CHAT_ID}:no-thread`);
    expect(getInteractionScope({ chat: { id: CHAT_ID } } as Context)).toBe(`${CHAT_ID}:no-thread`);
  });

  it("reads the thread id of a callback from its message", () => {
    expect(getInteractionScope(callbackIn(TOPIC_B, "model:foo"))).toBe(SCOPE_B);
    expect(getInteractionScope(callbackIn(undefined, "model:foo"))).toBe(`${CHAT_ID}:no-thread`);
  });
});

describe("interaction guard per scope", () => {
  beforeEach(() => {
    deps.interactionManager.reset("test_setup");
  });

  it("does not block a command in topic B while a menu is open in topic A", () => {
    startInteractionForTest(
      deps.interactionManager,
      { kind: "inline", expectedInput: "callback" },
      SCOPE_A,
    );

    const decision = resolveInteractionGuardDecision(textIn(TOPIC_B, "/new"), deps);

    expect(decision.allow).toBe(true);
    expect(decision.state).toBeNull();
  });

  it("still blocks a command in topic A while its own menu is open", () => {
    startInteractionForTest(
      deps.interactionManager,
      { kind: "inline", expectedInput: "callback", allowedCommands: ["/status"] },
      SCOPE_A,
    );

    const decision = resolveInteractionGuardDecision(textIn(TOPIC_A, "/new"), deps);

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("command_not_allowed");
    expect(decision.state?.kind).toBe("inline");
  });

  it("does not block General while a menu is open in a numbered topic", () => {
    startInteractionForTest(
      deps.interactionManager,
      { kind: "inline", expectedInput: "callback" },
      SCOPE_A,
    );

    const decision = resolveInteractionGuardDecision(textIn(undefined, "hello"), deps);

    expect(decision.allow).toBe(true);
    expect(decision.state).toBeNull();
  });

  it("does not block a numbered topic while a menu is open in General", () => {
    startInteractionForTest(
      deps.interactionManager,
      { kind: "inline", expectedInput: "callback" },
      `${CHAT_ID}:no-thread`,
    );

    const decision = resolveInteractionGuardDecision(textIn(TOPIC_A, "hello"), deps);

    expect(decision.allow).toBe(true);
    expect(decision.state).toBeNull();
  });

  it("reads the topic of a callback from the message it belongs to", () => {
    startInteractionForTest(
      deps.interactionManager,
      { kind: "inline", expectedInput: "callback" },
      SCOPE_A,
    );

    const own = resolveInteractionGuardDecision(callbackIn(TOPIC_A, "model:foo:bar"), deps);
    const other = resolveInteractionGuardDecision(callbackIn(TOPIC_B, "model:foo:bar"), deps);

    expect(own.allow).toBe(true);
    expect(own.state?.kind).toBe("inline");
    expect(other.allow).toBe(true);
    expect(other.state).toBeNull();
  });

  it("clears only the expired scope and leaves the other one active", () => {
    const referenceTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(referenceTime);

    startInteractionForTest(
      deps.interactionManager,
      { kind: "permission", expectedInput: "callback", expiresInMs: 1000 },
      SCOPE_A,
    );
    startInteractionForTest(
      deps.interactionManager,
      { kind: "permission", expectedInput: "callback" },
      SCOPE_B,
    );

    vi.setSystemTime(referenceTime + 1001);

    const expired = resolveInteractionGuardDecision(textIn(TOPIC_A, "hello"), deps);
    const alive = resolveInteractionGuardDecision(textIn(TOPIC_B, "hello"), deps);

    expect(expired.reason).toBe("expired");
    expect(deps.interactionManager.isActive(SCOPE_A)).toBe(false);
    expect(deps.interactionManager.isActive(SCOPE_B)).toBe(true);
    expect(alive.allow).toBe(false);
    expect(alive.reason).toBe("expected_callback");

    vi.useRealTimers();
  });

  it("counts only the scope of the update as busy-interaction-eligible", () => {
    deps.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");
    startInteractionForTest(
      deps.interactionManager,
      { kind: "question", expectedInput: "mixed" },
      SCOPE_A,
    );

    const ownAnswer = resolveInteractionGuardDecision(textIn(TOPIC_A, "custom answer"), deps);
    const otherCommand = resolveInteractionGuardDecision(textIn(TOPIC_B, "/new"), deps);

    expect(ownAnswer.allow).toBe(true);
    expect(otherCommand.allow).toBe(false);
    expect(otherCommand.reason).toBe("command_not_allowed");
  });
});
