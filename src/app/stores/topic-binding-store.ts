import { getTopicSessionBindings, setTopicSessionBindings } from "./settings-store.js";
import {
  parseTopicBindingKey,
  topicBindingKey,
  type TopicBindingEntry,
  type TopicSessionBinding,
  type TopicSessionBindingInput,
} from "../types/topics.js";
import { logger } from "../../utils/logger.js";

let mutationQueue: Promise<unknown> = Promise.resolve();

async function mutateBindings<T>(
  mutator: (bindings: Record<string, TopicSessionBinding>) => {
    bindings: Record<string, TopicSessionBinding>;
    result: T;
  },
): Promise<T> {
  const runMutation = async (): Promise<T> => {
    const currentBindings = getTopicSessionBindings();
    const { bindings, result } = mutator(currentBindings);
    await setTopicSessionBindings(bindings);
    return result;
  };

  const mutationPromise = mutationQueue.then(runMutation, runMutation);
  mutationQueue = mutationPromise.catch(() => undefined);
  return mutationPromise;
}

export function getTopicBinding(chatId: number, threadId: number): TopicSessionBinding | null {
  const binding = getTopicSessionBindings()[topicBindingKey(chatId, threadId)];
  return binding ? { ...binding } : null;
}

/**
 * Orders two candidate bindings deterministically: the newest `createdAt` wins,
 * with the settings key as tie-break so the result never depends on key order.
 */
function isMoreRecent(
  candidate: TopicSessionBinding,
  candidateKey: string,
  current: TopicSessionBinding,
  currentKey: string,
): boolean {
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt;
  }
  return candidateKey > currentKey;
}

export function getTopicBindingBySession(sessionId: string): TopicBindingEntry | null {
  let bestKey: string | null = null;
  let bestBinding: TopicSessionBinding | null = null;

  for (const [key, binding] of Object.entries(getTopicSessionBindings())) {
    if (binding.sessionId !== sessionId) continue;

    const parsed = parseTopicBindingKey(key);
    if (!parsed) continue;

    if (
      bestBinding === null ||
      bestKey === null ||
      isMoreRecent(binding, key, bestBinding, bestKey)
    ) {
      bestKey = key;
      bestBinding = binding;
    }
  }

  if (bestBinding === null || bestKey === null) return null;

  const parsed = parseTopicBindingKey(bestKey);
  if (!parsed) return null;

  return { chatId: parsed.chatId, threadId: parsed.threadId, binding: { ...bestBinding } };
}

export async function registerTopicBinding(input: TopicSessionBindingInput): Promise<void> {
  await mutateBindings((bindings) => {
    const key = topicBindingKey(input.chatId, input.threadId);
    const existing = bindings[key];

    // Invariant: one session maps to exactly one topic. Drop any other binding
    // for the same session so re-binding moves it instead of duplicating it.
    const nextBindings: Record<string, TopicSessionBinding> = {};
    for (const [entryKey, entry] of Object.entries(bindings)) {
      if (entry.sessionId === input.sessionId && entryKey !== key) continue;
      nextBindings[entryKey] = entry;
    }

    nextBindings[key] = {
      sessionId: input.sessionId,
      directory: input.directory,
      topicName: input.topicName,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    return {
      bindings: nextBindings,
      result: undefined,
    };
  });

  logger.info(
    `[TopicBindingStore] Registered topic binding: chatId=${input.chatId}, ` +
      `threadId=${input.threadId}, sessionId=${input.sessionId}`,
  );
}

export async function removeTopicBinding(chatId: number, threadId: number): Promise<boolean> {
  const removed = await mutateBindings((bindings) => {
    const key = topicBindingKey(chatId, threadId);
    if (!(key in bindings)) {
      return { bindings, result: false };
    }

    const nextBindings = { ...bindings };
    delete nextBindings[key];
    return { bindings: nextBindings, result: true };
  });

  if (removed) {
    logger.info(
      `[TopicBindingStore] Removed topic binding: chatId=${chatId}, threadId=${threadId}`,
    );
  }

  return removed;
}

export function listTopicBindings(): TopicBindingEntry[] {
  const entries: TopicBindingEntry[] = [];
  for (const [key, binding] of Object.entries(getTopicSessionBindings())) {
    const parsed = parseTopicBindingKey(key);
    if (!parsed) continue;
    entries.push({ chatId: parsed.chatId, threadId: parsed.threadId, binding: { ...binding } });
  }
  return entries;
}

export function __resetTopicBindingStoreForTests(): void {
  mutationQueue = Promise.resolve();
}
