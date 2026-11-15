/** One topic's session binding, stored under the "<chatId>:<threadId>" key. */
export interface TopicSessionBinding {
  /** The OpenCode session the topic is attached to. */
  sessionId: string;
  /** The working directory the session was started in. */
  directory: string;
  /** The Telegram topic name captured when the binding was created. */
  topicName: string;
  /** When the binding was first registered. */
  createdAt: string;
}

/** The data needed to register a topic binding. */
export interface TopicSessionBindingInput {
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  topicName: string;
}

/** A stored binding together with the topic it belongs to. */
export interface TopicBindingEntry {
  chatId: number;
  threadId: number;
  binding: TopicSessionBinding;
}

/** The settings key for one topic: "<chatId>:<threadId>". */
export function topicBindingKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

/** Reads a "<chatId>:<threadId>" key back, returning null when it is malformed. */
export function parseTopicBindingKey(key: string): { chatId: number; threadId: number } | null {
  const parts = key.split(":");
  if (parts.length !== 2) return null;

  const chatId = Number(parts[0]);
  const threadId = Number(parts[1]);
  if (!Number.isInteger(chatId) || !Number.isInteger(threadId)) return null;

  return { chatId, threadId };
}
