// source/channels/telegram-normalize.test.ts
import { describe, expect, it } from "vitest";
import { normalizeTelegramTextMessage, normalizeTelegramVoiceMessage } from "./telegram-normalize.js";

describe("telegram normalization helpers", () => {
  it("normalizes Telegram text updates into IncomingMessage", () => {
    const message = normalizeTelegramTextMessage({
      chatId: 123,
      fromId: 456,
      messageId: 789,
      text: "hello",
      raw: { message_id: 789 },
    });

    expect(message).toEqual({
      channelId: "123",
      userId: "456",
      messageId: "789",
      text: "hello",
      platform: "telegram",
      raw: { message_id: 789 },
    });
  });

  it("normalizes Telegram voice updates into IncomingMessage", () => {
    const audio = [{ path: "/tmp/input.ogg", mimeType: "audio/ogg", durationSeconds: 4 }];
    const message = normalizeTelegramVoiceMessage({
      chatId: 123,
      fromId: 456,
      messageId: 790,
      raw: { message_id: 790 },
      audio,
    });

    expect(message).toEqual({
      channelId: "123",
      userId: "456",
      messageId: "790",
      text: "The user sent a voice message.",
      platform: "telegram",
      raw: { message_id: 790 },
      audio,
      replyMode: "voice",
    });
  });
});
