import type { Context, NextFunction } from "grammy";
import { getTopicBinding } from "../../app/stores/topic-binding-store.js";
import { logger } from "../../utils/logger.js";

/**
 * The session a forum topic input belongs to, resolved from its binding. Carried on the
 * grammy context itself (there is no session plugin in this bot) so the message handlers
 * can pick it up later without changing their signatures.
 */
export interface TopicScope {
  sessionId: string;
  directory: string;
  /** Display fallback: a binding stores the topic name, not the session title. */
  title: string;
}

const topicScopeKey: unique symbol = Symbol("topicScope");

type ContextWithTopicScope = Context & {
  [topicScopeKey]?: TopicScope;
};

export function setTopicScope(ctx: Context, scope: TopicScope): void {
  (ctx as ContextWithTopicScope)[topicScopeKey] = scope;
}

export function getTopicScope(ctx: Context): TopicScope | null {
  return (ctx as ContextWithTopicScope)[topicScopeKey] ?? null;
}

/** Thread (forum topic) the update came from, or null for General and non-message updates. */
export function getMessageThreadId(ctx: Context): number | null {
  const threadId =
    ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  return typeof threadId === "number" ? threadId : null;
}

/**
 * Resolves which session the update belongs to and stores it on the context. Registered
 * after auth and before the routers.
 *
 * Only bound topics get a scope: for an unbound topic nothing is set, so the input keeps
 * flowing to the global session exactly as before.
 *
 * TODO(topic-scope): the policy for an unbound topic (refuse the prompt or warn the user)
 * is deliberately out of scope for the spike; until then unbound topics fall back to the
 * previous single-session behaviour.
 */
export async function topicScopeMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const threadId = getMessageThreadId(ctx);
  const chatId = ctx.chat?.id;

  if (threadId === null || typeof chatId !== "number") {
    await next();
    return;
  }

  const binding = getTopicBinding(chatId, threadId);
  if (binding) {
    setTopicScope(ctx, {
      sessionId: binding.sessionId,
      directory: binding.directory,
      title: binding.topicName,
    });
    logger.debug(
      `[TopicScope] Bound topic input: chatId=${chatId}, threadId=${threadId}, sessionId=${binding.sessionId}`,
    );
  } else {
    logger.debug(
      `[TopicScope] Unbound topic input falls back to the global session: chatId=${chatId}, threadId=${threadId}`,
    );
  }

  await next();
}
