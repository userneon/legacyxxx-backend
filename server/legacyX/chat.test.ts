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
    expect(checkChatBody("ab ".repeat(100), false).ok).toBe(true);
    expect(checkChatBody("ab ".repeat(101), false)).toEqual({ ok: false, problem: "too_long" });
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

import { hasLongRun, isShouting, spamKey, spamProblem } from "./chat";

describe("chat spam checks", () => {
  it("stops long runs of one character and shouting", () => {
    expect(hasLongRun("aaaaaaaaaa")).toBe(true);
    expect(hasLongRun("hahahahahaha")).toBe(false);
    expect(hasLongRun("gggggggg")).toBe(false);
    expect(isShouting("BUY NOW CHEAP SKINS HERE EVERYONE")).toBe(true);
    expect(isShouting("GG WP")).toBe(false);
    expect(isShouting("gg wp that was a very close match")).toBe(false);
    expect(checkChatBody("LOOK AT THIS GREAT OFFER FOR YOU ALL", false)).toEqual({ ok: false, problem: "shouting" });
    expect(checkChatBody("LOOK AT THIS GREAT OFFER FOR YOU ALL", true).ok).toBe(true);
  });

  it("reduces a message to what it says", () => {
    expect(spamKey("GG!!!")).toBe(spamKey("gg"));
    expect(spamKey("Сайн  уу?")).toBe("сайнуу");
  });

  const now = 1_000_000;
  it("refuses a repeat from the same player, a copy from several, and a flood", () => {
    expect(spamProblem("gg wp", "u1", [{ userId: "u1", body: "GG WP!", at: now - 30_000 }], now, 10)).toBe("duplicate");
    expect(spamProblem("gg wp", "u1", [{ userId: "u1", body: "gg wp", at: now - 130_000 }], now, 10)).toBeNull();
    expect(spamProblem("join my server now", "u3", [{ userId: "u1", body: "join my server now", at: now - 5_000 }, { userId: "u2", body: "Join my server now!", at: now - 3_000 }], now, 10)).toBe("copied");
    expect(spamProblem("join my server now", "u3", [{ userId: "u1", body: "join my server now", at: now - 5_000 }], now, 10)).toBeNull();
    const flood = Array.from({ length: 5 }, (_, index) => ({ userId: "u1", body: `message ${index}`, at: now - index * 1000 }));
    expect(spamProblem("another one", "u1", flood, now, 5)).toBe("too_fast");
    expect(spamProblem("another one", "u1", flood, now, 6)).toBeNull();
  });
});
