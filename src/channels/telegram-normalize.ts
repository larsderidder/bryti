// source/channels/telegram-normalize.ts
import type { AudioAttachment, IncomingMessage } from "./types.js";

interface TelegramMessageBaseParams {
  chatId: string | number;
  fromId: string | number;
  messageId?: string | number;
  raw: unknown;
}

interface TelegramTextMessageParams extends TelegramMessageBaseParams {
  text: string;
}

interface TelegramVoiceMessageParams extends TelegramMessageBaseParams {
  text?: string;
  audio: AudioAttachment[];
}

interface TelegramImageMessageParams extends TelegramMessageBaseParams {
  text: string;
  images: NonNullable<IncomingMessage["images"]>;
}

function telegramBaseMessage(params: TelegramMessageBaseParams): Pick<IncomingMessage, "channelId" | "userId" | "platform" | "raw" | "messageId"> {
  return {
    channelId: String(params.chatId),
    userId: String(params.fromId),
    platform: "telegram",
    raw: params.raw,
    ...(params.messageId != null ? { messageId: String(params.messageId) } : {}),
  };
}

export function normalizeTelegramTextMessage(params: TelegramTextMessageParams): IncomingMessage {
  return {
    ...telegramBaseMessage(params),
    text: params.text,
  };
}

export function normalizeTelegramVoiceMessage(params: TelegramVoiceMessageParams): IncomingMessage {
  return {
    ...telegramBaseMessage(params),
    text: params.text ?? "The user sent a voice message.",
    audio: params.audio,
    replyMode: "voice",
  };
}

export function normalizeTelegramImageMessage(params: TelegramImageMessageParams): IncomingMessage {
  return {
    ...telegramBaseMessage(params),
    text: params.text,
    images: params.images,
  };
}
