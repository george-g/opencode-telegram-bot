import { describe, expect, it } from "vitest";
import { isTopicNotFoundError } from "../../src/utils/telegram-topic-error.js";

/** A grammY-style API error: `error_code` and `description` on one object. */
function telegramError(errorCode: number, description: string): Error {
  return Object.assign(new Error(`Call to 'sendMessage' failed! (${errorCode}: ${description})`), {
    error_code: errorCode,
    description,
  });
}

describe("utils/telegram-topic-error", () => {
  it("is true for the 400 a deleted forum topic answers with", () => {
    expect(
      isTopicNotFoundError(telegramError(400, "Bad Request: message thread not found")),
    ).toBe(true);
  });

  it("is false when only the message carries the phrase, with no code to gate it", () => {
    expect(isTopicNotFoundError(new Error("400 Bad Request: message thread not found"))).toBe(false);
  });

  it("is false for another 400", () => {
    expect(isTopicNotFoundError(telegramError(400, "Bad Request: chat not found"))).toBe(false);
  });

  it("is false for a 403 that mentions no thread", () => {
    expect(
      isTopicNotFoundError(telegramError(403, "Forbidden: bot is not a member of the chat")),
    ).toBe(false);
  });

  it("is false for a 403 that carries the phrase, because the code gates it", () => {
    expect(isTopicNotFoundError(telegramError(403, "Forbidden: message thread not found"))).toBe(
      false,
    );
  });

  it("is false for a rate limit and for unusable values", () => {
    expect(isTopicNotFoundError(telegramError(429, "Too Many Requests: retry after 3"))).toBe(false);
    expect(isTopicNotFoundError(null)).toBe(false);
    expect(isTopicNotFoundError(undefined)).toBe(false);
    expect(isTopicNotFoundError("message thread not found")).toBe(false);
    expect(isTopicNotFoundError({})).toBe(false);
  });

  it("accepts a status field in place of error_code", () => {
    expect(
      isTopicNotFoundError({ status: 400, description: "Bad Request: message thread not found" }),
    ).toBe(true);
  });

  it("accepts the same words written with underscores or a colon", () => {
    expect(isTopicNotFoundError(telegramError(400, "Bad Request: MESSAGE_THREAD_NOT_FOUND"))).toBe(
      true,
    );
    expect(
      isTopicNotFoundError(telegramError(400, "Bad Request: message: thread not found")),
    ).toBe(true);
  });

  it("does not match across two fields of one error", () => {
    // The description ends with "message" and the message starts with "thread";
    // neither field carries the phrase, so the join must not invent one.
    expect(
      isTopicNotFoundError({
        error_code: 400,
        description: "Bad Request: message",
        message: "thread not found",
      }),
    ).toBe(false);
  });
});
