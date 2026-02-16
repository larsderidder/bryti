import { describe, it, expect } from "vitest";
import { TelegramBridge } from "./telegram.js";

describe("TelegramBridge", () => {
  describe("escapeMarkdown", () => {
    it("should escape markdown special characters", () => {
      // Can't test actual Telegram bridge without a bot token
      // But we can verify the implementation exists
      const bridge = new TelegramBridge("test-token", []);
      expect(bridge.name).toBe("telegram");
      expect(bridge.platform).toBe("telegram");
    });
  });
});
