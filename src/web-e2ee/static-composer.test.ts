import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync("src/web-e2ee/static/index.html", "utf8");
const stylesCss = readFileSync("src/web-e2ee/static/styles.css", "utf8");
const appJs = readFileSync("src/web-e2ee/static/app.js", "utf8");

describe("web_e2ee chat composer", () => {
  it("uses an accessible autosizing textarea for encrypted text", () => {
    expect(indexHtml).toContain("<label class=\"visually-hidden\" for=\"chat-input\">Encrypted message to Bryti</label>");
    expect(indexHtml).toContain("<textarea id=\"chat-input\" rows=\"1\" placeholder=\"Pair and connect to enable encrypted outbound text\" disabled></textarea>");
    expect(indexHtml).not.toContain("<input id=\"chat-input\" type=\"text\"");

    expect(stylesCss).toContain(".chat-composer");
    expect(stylesCss).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(stylesCss).toContain("max-height: min(40vh, 14rem);");
    expect(stylesCss).toContain("overflow-y: hidden;");
  });

  it("autosizes, resets after send, and keeps Shift+Enter for newlines", () => {
    expect(appJs).toContain("function resizeChatInput()");
    expect(appJs).toContain("chatInputEl.addEventListener(\"input\", () =>");
    expect(appJs).toContain("resizeChatInput();\n    appendChatMessage(\"user\", text);");
    expect(appJs).toContain("event.key === \"Enter\" && !event.shiftKey && !event.isComposing && !chatSendEl.disabled");
  });
});
