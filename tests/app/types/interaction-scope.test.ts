import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERACTION_SCOPE,
  INTERACTION_SCOPE_NO_THREAD,
  interactionScopeFromDestination,
  interactionScopeKey,
} from "../../../src/app/types/interaction-scope.js";

describe("interaction scope key", () => {
  it("uses a numbered topic key for a thread id", () => {
    expect(interactionScopeKey(100, 42)).toBe("100:42");
    expect(interactionScopeKey(-5, 7)).toBe("-5:7");
  });

  it("builds the no-thread key from the chat id and the no-thread marker", () => {
    expect(interactionScopeKey(100, null)).toBe(`100:${INTERACTION_SCOPE_NO_THREAD}`);
    expect(interactionScopeKey(100, undefined)).toBe(`100:${INTERACTION_SCOPE_NO_THREAD}`);
    expect(interactionScopeKey(100, null)).toBe("100:no-thread");
  });

  it("never lets the General topic collide with a numbered topic", () => {
    const general = interactionScopeKey(100, null);
    const topic = interactionScopeKey(100, 42);

    expect(general).not.toBe(topic);
    expect(topic).toBe("100:42");
  });

  it("keeps the no-thread key of one chat away from the no-thread key of another", () => {
    expect(interactionScopeKey(100, null)).not.toBe(interactionScopeKey(999, null));
    expect(interactionScopeKey(100, null)).toBe("100:no-thread");
    expect(interactionScopeKey(999, null)).toBe("999:no-thread");
  });

  it("defaults the scope of callers that name none to a sentinel no real key builds", () => {
    expect(DEFAULT_INTERACTION_SCOPE).toBe("__no-scope__");
    expect(DEFAULT_INTERACTION_SCOPE).not.toBe(INTERACTION_SCOPE_NO_THREAD);
    expect(DEFAULT_INTERACTION_SCOPE).not.toBe(interactionScopeKey(100, null));
    expect(DEFAULT_INTERACTION_SCOPE).not.toBe(interactionScopeKey(100, 42));
  });

  it("maps a destination to its scope, thread or not", () => {
    expect(interactionScopeFromDestination({ chatId: 100, messageThreadId: 42 })).toBe("100:42");
    expect(interactionScopeFromDestination({ chatId: 100 })).toBe("100:no-thread");
    expect(interactionScopeFromDestination({ chatId: 100, messageThreadId: undefined })).toBe(
      "100:no-thread",
    );
  });
});
