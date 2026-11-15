import { InputFile, type Bot, type Context } from "grammy";
import type { CodeFileData } from "../../app/formatters/summary-formatter.js";
import { logger } from "../../utils/logger.js";
import {
  AGENT_TEXT_LINK_PREVIEW_OPTIONS,
  completeDraftPart,
  editRenderedBotPart,
  getTelegramRenderedPartSignature,
  sendDraftBotPart,
  sendRenderedBotPart,
} from "../messages/telegram-text.js";
import type { TelegramRenderedPart } from "../render/types.js";

type TelegramApi = Bot<Context>["api"];
type SendMessageOptions = Parameters<TelegramApi["sendMessage"]>[2];
type SendDocumentOptions = Parameters<TelegramApi["sendDocument"]>[2];
type RenderedSendOptions = Parameters<typeof sendRenderedBotPart>[0]["options"];
type RenderedEditOptions = Parameters<typeof editRenderedBotPart>[0]["options"];
type DraftCompleteOptions = Parameters<typeof completeDraftPart>[0]["options"];

/**
 * editMessageText has no topic in its typed payload: the topic is implied by
 * the message being edited, so grammY exposes message_thread_id on the send
 * methods but not here. The delivery still forwards it for bound topics.
 */
type EditMessageTextOptions = NonNullable<Parameters<TelegramApi["editMessageText"]>[3]> & {
  message_thread_id?: number;
};

/** Where a session's messages go. */
export interface TelegramDestination {
  api: TelegramApi;
  chatId: number;
  /**
   * The forum topic the session's chat belongs to, when it is bound to one.
   * Absent for every chat that is not a bound topic, which keeps the plain
   * chat send untouched.
   */
  messageThreadId?: number;
}

/**
 * Adds the destination's topic to a Telegram options object, but only when the
 * destination names one: an unbound chat keeps exactly the options it had.
 */
function withMessageThread<T extends object>(
  options: T | undefined,
  destination: TelegramDestination,
): T | undefined {
  const threadId = destination.messageThreadId;
  if (threadId === undefined) {
    return options;
  }

  return { ...(options ?? {}), message_thread_id: threadId } as T;
}

/**
 * A draft send with the destination's topic. grammY types sendMessageDraft /
 * sendRichMessageDraft with message_thread_id, but the shared helpers in
 * telegram-text.ts do not forward an options object, so the delivery issues the
 * call itself when (and only when) the destination is bound to a topic.
 */
async function sendDraftPartWithThread(
  destination: TelegramDestination,
  draftId: number,
  part: TelegramRenderedPart,
): Promise<{ deliveredSignature: string }> {
  const threadId = destination.messageThreadId;
  if (threadId === undefined) {
    return sendDraftBotPart({
      api: destination.api,
      chatId: destination.chatId,
      draftId,
      part,
    });
  }

  const api = destination.api as unknown as DraftApiWithThread;
  const messageThreadId = { message_thread_id: threadId };
  if (part.source === "plain" || part.blocks.length === 0) {
    await api.sendMessageDraft(destination.chatId, draftId, part.fallbackText, messageThreadId);
    return {
      deliveredSignature: getTelegramRenderedPartSignature({
        blocks: [],
        fallbackText: part.fallbackText,
        source: "plain",
      }),
    };
  }

  await api.sendRichMessageDraft(
    destination.chatId,
    draftId,
    { blocks: part.blocks },
    messageThreadId,
  );
  return { deliveredSignature: getTelegramRenderedPartSignature(part) };
}

interface DraftApiWithThread {
  sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
    options: { message_thread_id: number },
  ): Promise<unknown>;
  sendRichMessageDraft(
    chatId: number,
    draftId: number,
    richMessage: { blocks: TelegramRenderedPart["blocks"] },
    options: { message_thread_id: number },
  ): Promise<unknown>;
}

/**
 * Decides, per session, where its messages go and whether it is the session
 * the user follows. The two answers are independent on purpose.
 */
export interface SessionTargetPolicy {
  getDestination(sessionId: string): TelegramDestination | null;
  isForegroundSession(sessionId: string): boolean;
}

function getLowerCaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

function isMessageNotModifiedError(error: unknown): boolean {
  return getLowerCaseErrorMessage(error).includes("message is not modified");
}

function isMessageToDeleteMissingError(error: unknown): boolean {
  const errorMessage = getLowerCaseErrorMessage(error);
  return (
    errorMessage.includes("message to delete not found") ||
    errorMessage.includes("message identifier is not specified")
  );
}

/**
 * Telegram primitives for the event bridge. Every call names its destination;
 * only "not modified" edits and already-missing deletes are tolerated, anything
 * else (a 429 included) reaches the caller so the streamers can retry.
 */
export class TelegramEventDelivery {
  private nextDraftId = 1;

  async sendText(
    destination: TelegramDestination,
    text: string,
    options?: SendMessageOptions,
  ): Promise<number> {
    const threadOptions = withMessageThread(options, destination);
    const sentMessage =
      threadOptions === undefined
        ? await destination.api.sendMessage(destination.chatId, text)
        : await destination.api.sendMessage(destination.chatId, text, threadOptions);
    return sentMessage.message_id;
  }

  async editText(destination: TelegramDestination, messageId: number, text: string): Promise<void> {
    const options = withMessageThread<EditMessageTextOptions>(undefined, destination);
    try {
      if (options === undefined) {
        await destination.api.editMessageText(destination.chatId, messageId, text);
      } else {
        await destination.api.editMessageText(destination.chatId, messageId, text, options);
      }
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        return;
      }

      throw error;
    }
  }

  async deleteText(destination: TelegramDestination, messageId: number): Promise<void> {
    await destination.api.deleteMessage(destination.chatId, messageId).catch((error) => {
      if (isMessageToDeleteMissingError(error)) {
        return;
      }

      throw error;
    });
  }

  async sendDocument(
    destination: TelegramDestination,
    fileData: CodeFileData,
    options?: SendDocumentOptions,
  ): Promise<void> {
    logger.debug(`[Bot] Sending code file: ${fileData.filename} (${fileData.buffer.length} bytes)`);

    // Hand the buffer straight to grammY: no temp file on disk, so no writable
    // install directory to depend on and no name collisions between uploads.
    await destination.api.sendDocument(
      destination.chatId,
      new InputFile(fileData.buffer, fileData.filename),
      withMessageThread(
        {
          caption: fileData.caption,
          ...options,
        },
        destination,
      ),
    );
  }

  sendRenderedPart(
    destination: TelegramDestination,
    part: TelegramRenderedPart,
    options?: RenderedSendOptions,
    allowPlainFallback?: boolean,
  ) {
    return sendRenderedBotPart({
      api: destination.api,
      chatId: destination.chatId,
      part,
      options: withMessageThread({ ...options, ...AGENT_TEXT_LINK_PREVIEW_OPTIONS }, destination),
      ...(allowPlainFallback === undefined ? {} : { allowPlainFallback }),
    });
  }

  async editRenderedPart(
    destination: TelegramDestination,
    messageId: number,
    part: TelegramRenderedPart,
    options?: RenderedEditOptions,
  ) {
    try {
      return await editRenderedBotPart({
        api: destination.api,
        chatId: destination.chatId,
        messageId,
        part,
        options: withMessageThread(
          { ...options, ...AGENT_TEXT_LINK_PREVIEW_OPTIONS },
          destination,
        ),
        allowPlainFallback: false,
      });
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        return { deliveredSignature: getTelegramRenderedPartSignature(part) };
      }

      throw error;
    }
  }

  /** Starts a new draft; its id is the stream's message id from then on. */
  async sendDraftPart(destination: TelegramDestination, part: TelegramRenderedPart) {
    const draftId = this.nextDraftId;
    this.nextDraftId += 1;
    const result = await this.editDraftPart(destination, draftId, part);
    return { messageId: draftId, deliveredSignature: result.deliveredSignature };
  }

  editDraftPart(destination: TelegramDestination, draftId: number, part: TelegramRenderedPart) {
    return sendDraftPartWithThread(destination, draftId, part);
  }

  completeDraftPart(
    destination: TelegramDestination,
    part: TelegramRenderedPart,
    options?: DraftCompleteOptions,
  ) {
    return completeDraftPart({
      api: destination.api,
      chatId: destination.chatId,
      part,
      options: withMessageThread(
        { ...options, ...AGENT_TEXT_LINK_PREVIEW_OPTIONS },
        destination,
      ),
    });
  }

  resetDraftIds(): void {
    this.nextDraftId = 1;
  }
}
