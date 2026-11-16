import type { Context } from "grammy";
import { interactionScopeKey } from "../../app/types/interaction-scope.js";

/**
 * The interaction scope of an update. The guard and the routers run before the
 * topic scope middleware, so the scope is read from the context itself. GrammY
 * exposes a thread id on a message, and a callback query carries the message it
 * belongs to, so its thread comes off that message.
 */
export function getInteractionScope(ctx: Context): string {
  const threadId =
    ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
  return interactionScopeKey(ctx.chat?.id ?? 0, threadId);
}
