import { topicBindingKey } from "./topics.js";

/**
 * The part of a scope key that marks a chat without a thread. Telegram gives the
 * General topic of a forum no explicit thread id in updates, so General lands in
 * this bucket on purpose. A numbered forum topic never builds this key, so General
 * and a numbered topic cannot collide.
 */
export const INTERACTION_SCOPE_NO_THREAD = "no-thread";

/**
 * The interaction scope of one chat and topic: "<chatId>:<threadId>" for a forum
 * topic, "<chatId>:no-thread" otherwise. It is the same key format the topic
 * session bindings use in settings.json.
 *
 * The key always carries the chat id, so slots never merge across chats. Two chats
 * with no thread id get two different keys, unlike the single no-thread key.
 */
export function interactionScopeKey(chatId: number, threadId: number | null | undefined): string {
  if (threadId === null || threadId === undefined) {
    return `${chatId}:${INTERACTION_SCOPE_NO_THREAD}`;
  }

  return topicBindingKey(chatId, threadId);
}

/**
 * The interaction scope of a message destination: a bound topic maps to its own
 * scope, every other destination to the no-thread scope.
 */
export function interactionScopeFromDestination(destination: {
  chatId: number;
  messageThreadId?: number | undefined;
}): string {
  return interactionScopeKey(destination.chatId, destination.messageThreadId ?? null);
}

/**
 * The scope of callers that name no chat or topic: tests, and the code paths that
 * run outside an update. It is a sentinel that no real key builds, because every
 * real key carries a chat id.
 */
export const DEFAULT_INTERACTION_SCOPE = "__no-scope__";
