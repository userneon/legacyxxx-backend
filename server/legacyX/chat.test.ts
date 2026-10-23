import { describe, expect, it } from "vitest";
import { checkChatBody, cleanChatBody, hasLink } from "./chat";

describe("public chat messages", () => {
  it("cleans spacing and control characters", () => {
    expect(cleanChatBody("  hi\n\n  there​  ")).toBe("hi there");
    expect(cleanChatBody("a\u0007b")).toBe("a b");
  });
  it("refuses empty and over-long messages", () => {
    expect(checkChatBody("  \n ", false)).toEqual({ ok: false, problem: "empty" });
    expect(checkChatBody("x".repeat(301), false)).toEqual({ ok: false, problem: "too_long" });
    expect(checkChatBody("x".repeat(300), false).ok).toBe(true);
  });
  it("keeps links to staff", () => {
    for (const text of ["visit https://evil.example/x", "www.site.com", "join discord.gg/abc", "go to spam dot com", "t.me/spammer", "shop(dot)net"]) {
      expect(hasLink(text)).toBe(true);
      expect(checkChatBody(text, false)).toEqual({ ok: false, problem: "link" });
      expect(checkChatBody(text, true).ok).toBe(true);
    }
  });
  it("lets ordinary talk through", () => {
    for (const text of ["gg wp", "anyone for 5x5 at 8.30?", "Mirage or Dust II.", "Сайн уу, хэн тоглох вэ"]) expect(checkChatBody(text, false).ok).toBe(true);
  });
});
