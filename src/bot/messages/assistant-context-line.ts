import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { getModelContextLimit } from "../../app/services/model-context-limit-service.js";
import { t } from "../../i18n/index.js";
import { formatContextLine, formatModelDisplayName } from "../pinned/pinned-message-format.js";
import type { TelegramDestination } from "../events/telegram-event-delivery.js";
import type { SessionRuntimeState } from "../events/session-runtime-state.js";

/**
 * A topic opens every new agent message with one short line: the model of the
 * current selection and the context size last seen for the session.
 */
export function formatAssistantContextLine(
  tokensUsed: number,
  tokensLimit: number | null,
): string {
  const model = getStoredModel();
  const modelName = formatModelDisplayName(model.providerID, model.modelID, model.variant);
  const contextLine = formatContextLine(tokensUsed, tokensLimit);

  return `${t("pinned.line.model", { model: modelName })} · ${contextLine}`;
}

/**
 * Sends the context line into the session's destination, which is the bound
 * topic. A failed send is logged and swallowed: the reply still has to go out.
 */
export async function sendAssistantContextLine(
  runtime: SessionRuntimeState,
  destination: TelegramDestination,
  sessionId: string,
): Promise<void> {
  const usage = runtime.getSessionContextUsage(sessionId);
  const tokensLimit = usage?.tokensLimit ?? null;
  const line = formatAssistantContextLine(usage?.tokensUsed ?? 0, tokensLimit);
  requestSessionContextLimit(runtime, sessionId, tokensLimit);

  try {
    await runtime.delivery.sendText(destination, line, { disable_notification: true });
  } catch (error) {
    logger.warn(`[Bot] Failed to send the context line: session=${sessionId}`, error);
  }
}

/**
 * Reads the model's context limit in the background while the session has none.
 * Each session asks once: a limit that stays unknown is not asked again.
 */
function requestSessionContextLimit(
  runtime: SessionRuntimeState,
  sessionId: string,
  tokensLimit: number | null,
): void {
  if (tokensLimit !== null || !runtime.beginSessionContextLimitRequest(sessionId)) {
    return;
  }

  const model = getStoredModel();
  safeBackgroundTask({
    taskName: "assistant.context_line_limit",
    task: () => getModelContextLimit(model.providerID, model.modelID),
    onSuccess: (limit) => runtime.setSessionContextLimit(sessionId, limit),
  });
}
