import { removeTopicBinding } from "../../app/stores/topic-binding-store.js";
import { topicBindingKey } from "../../app/types/topics.js";
import { logger } from "../../utils/logger.js";
import { isTopicNotFoundError } from "../../utils/telegram-topic-error.js";

/**
 * How long one dead topic stays marked. A burst of sends that carry the same
 * thread id reaches the store one after another, and each of them sees the
 * binding still in place; the mark spares every later one of the burst the same
 * removal and the same warning.
 */
const DEAD_TOPIC_MEMORY_MS = 30_000;

const deadTopics = new Map<string, number>();

function topicKey(chatId: number, threadId: number): string {
  return topicBindingKey(chatId, threadId);
}

function isMarkedDead(key: string, now: number): boolean {
  const markedAt = deadTopics.get(key);
  if (markedAt === undefined) {
    return false;
  }

  if (now - markedAt >= DEAD_TOPIC_MEMORY_MS) {
    deadTopics.delete(key);
    return false;
  }

  return true;
}

/**
 * Drops the binding of a topic Telegram reports as missing, and reports whether
 * this call removed one. Only a `400 message thread not found` reaches this
 * point: any other failure is left to its caller. Delivery never creates a
 * topic - a deleted one is replaced only in the selection ceremony - so removing
 * the binding is all this does. The removal is durable: every later destination
 * read comes back without the thread, which is what stops the sends.
 */
export async function dropDeadTopicBinding(
  chatId: number,
  threadId: number,
  error: unknown,
): Promise<boolean> {
  if (!isTopicNotFoundError(error)) {
    return false;
  }

  const key = topicKey(chatId, threadId);
  const now = Date.now();
  if (isMarkedDead(key, now)) {
    return false;
  }

  deadTopics.set(key, now);
  logger.warn(
    `[Topics] Telegram reports the bound forum topic as missing, dropping the binding: chatId=${chatId}, threadId=${threadId}`,
  );

  // The mark is per chat:thread and the TTL expires it. A topic bound again gets
  // a fresh thread id from Telegram, so this mark can never poison the new one.
  return removeTopicBinding(chatId, threadId).catch((removeError) => {
    // A failed removal must not leave the topic marked: the next send retries it.
    deadTopics.delete(key);
    logger.error("[Topics] Failed to drop the binding of a deleted forum topic:", removeError);
    return false;
  });
}

export function __resetDeadTopicLatchesForTests(): void {
  deadTopics.clear();
}
