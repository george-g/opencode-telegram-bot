/**
 * The phrase Telegram answers with for a forum topic that no longer exists.
 * Telegram has no read-only way to look a topic up - there is no `getForumTopic`
 * method, and `sendChatAction` answers `ok` for a dead thread id - so a failed
 * send is the only report that a topic is gone.
 */
const TOPIC_NOT_FOUND_MARKER = "message thread not found";

/**
 * Folds every run of separators into one space. A variant such as
 * `MESSAGE_THREAD_NOT_FOUND` or `message: thread not found` carries the same
 * words and means the same failure, so the phrase stays matchable. The words
 * themselves are never dropped, and the `400` gate still keeps an unrelated
 * failure out.
 */
function normalizeSeparators(text: string): string {
  return text.replace(/[_\s:]+/g, " ");
}

function getErrorText(error: unknown): string {
  const parts: string[] = [];

  if (typeof error === "object" && error !== null) {
    const description = Reflect.get(error, "description");
    if (typeof description === "string") {
      parts.push(description);
    }

    const message = Reflect.get(error, "message");
    if (typeof message === "string") {
      parts.push(message);
    }
  }

  if (typeof error === "string") {
    parts.push(error);
  }

  // A null byte keeps the fields apart: a newline folds into a space with the
  // rest of the separators, and the folded text must not match across fields.
  return parts.join("\0").toLowerCase();
}

function getErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const errorCode = Reflect.get(error, "error_code");
  if (typeof errorCode === "number" && Number.isFinite(errorCode)) {
    return errorCode;
  }

  const status = Reflect.get(error, "status");
  if (typeof status === "number" && Number.isFinite(status)) {
    return status;
  }

  return null;
}

/**
 * True when Telegram answers that the forum topic does not exist. A GrammyError
 * carries `error_code` and `description`, so both are checked: the `400` gate
 * keeps an unrelated failure that merely mentions the phrase out. The topic has
 * no structured parameter, so the description is the only source of the phrase.
 * The words are matched with any separator between them: Telegram writes the
 * phrase with spaces today, and an underscored variant means the same failure.
 */
export function isTopicNotFoundError(error: unknown): boolean {
  if (getErrorCode(error) !== 400) {
    return false;
  }

  return normalizeSeparators(getErrorText(error)).includes(TOPIC_NOT_FOUND_MARKER);
}
