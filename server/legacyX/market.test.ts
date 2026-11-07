import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { MARKET_LIMITS, cleanBlock, cleanLine, isListed, marketListingSchema, marketQuerySchema, processMarketImage } from "./market";

describe("market listing input", () => {
  it("needs a title and nothing else", () => {
    const ok = marketListingSchema.safeParse({ title: "  AK-47   Redline  " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual({ title: "AK-47 Redline", description: "" });
    expect(marketListingSchema.safeParse({ title: "ab" }).success).toBe(false);
    expect(marketListingSchema.safeParse({}).success).toBe(false);
  });
  it("takes an optional price, phone and email and refuses bad ones", () => {
    const ok = marketListingSchema.parse({ title: "Mouse", priceMnt: 50000, phone: "+976 9911-2233", email: "Me@Example.COM", description: "Line one\r\n\r\n\r\n\r\nLine two" });
    expect(ok.priceMnt).toBe(50000);
    expect(ok.phone).toBe("+976 9911-2233");
    expect(ok.email).toBe("me@example.com");
    expect(ok.description).toBe("Line one\n\nLine two");
    expect(marketListingSchema.safeParse({ title: "Mouse", priceMnt: -1 }).success).toBe(false);
    expect(marketListingSchema.safeParse({ title: "Mouse", priceMnt: 1.5 }).success).toBe(false);
    expect(marketListingSchema.safeParse({ title: "Mouse", phone: "call me <b>" }).success).toBe(false);
    expect(marketListingSchema.safeParse({ title: "Mouse", email: "nope" }).success).toBe(false);
    expect(marketListingSchema.parse({ title: "Mouse", phone: "", email: "", priceMnt: null })).toEqual({ title: "Mouse", description: "" });
  });
  it("refuses fields it does not know", () => {
    expect(marketListingSchema.safeParse({ title: "Mouse", status: "sold" }).success).toBe(false);
  });
  it("cleans text", () => {
    expect(cleanLine("a\u0007 b\u200b  c", 10)).toBe("a b c");
    expect(cleanBlock("a\u0000b  \n\n\n\nc", 20)).toBe("ab\n\nc");
    expect(cleanBlock("x".repeat(3000), 2000)).toHaveLength(2000);
  });
  it("reads the list query", () => {
    expect(marketQuerySchema.parse({})).toEqual({ q: "", page: 1 });
    expect(marketQuerySchema.parse({ q: " mouse ", page: "2" })).toEqual({ q: "mouse", page: 2 });
    expect(marketQuerySchema.safeParse({ page: "0" }).success).toBe(false);
  });
});

describe("market pictures", () => {
  it("re-encodes a picture to WebP no wider than 1400 px", async () => {
    const png = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer();
    const made = await processMarketImage(png);
    const info = await sharp(made.data).metadata();
    expect(made.mime).toBe("image/webp");
    expect(info.format).toBe("webp");
    expect(info.width).toBe(MARKET_LIMITS.imageWidth);
  });
  it("refuses what is not a picture or is empty", async () => {
    await expect(processMarketImage(Buffer.from("hello"))).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
    await expect(processMarketImage(Buffer.alloc(0))).rejects.toThrow(/request body/);
  });
});

describe("listed", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  it("shows an active, not expired, not much reported listing", () => {
    expect(isListed({ status: "active", report_count: 0, expires_at: future })).toBe(true);
    expect(isListed({ status: "sold", report_count: 0, expires_at: future })).toBe(false);
    expect(isListed({ status: "active", report_count: 3, expires_at: future })).toBe(false);
    expect(isListed({ status: "active", report_count: 0, expires_at: new Date(Date.now() - 1000).toISOString() })).toBe(false);
  });
});
