import { describe, expect, it } from "vitest";
import { parseTikTokPage, tiktokProfile } from "./tiktokStats";

describe("tiktokProfile", () => {
  it("accepts a tiktok.com profile and rebuilds a clean link", () => {
    expect(tiktokProfile("https://tiktok.com/@legacyx?lang=en")).toEqual({ url: "https://www.tiktok.com/@legacyx", handle: "@legacyx" });
  });
  it("refuses other hosts, http and links without a handle", () => {
    expect(tiktokProfile("https://evil.example/@legacyx")).toBeNull();
    expect(tiktokProfile("http://www.tiktok.com/@legacyx")).toBeNull();
    expect(tiktokProfile("https://www.tiktok.com/")).toBeNull();
    expect(tiktokProfile(undefined)).toBeNull();
  });
});

describe("parseTikTokPage", () => {
  const page = (stats: unknown) => `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.user-detail": { userInfo: { stats } } } })}</script></html>`;
  it("reads followers and videos", () => {
    expect(parseTikTokPage(page({ followerCount: 1250, videoCount: 42 }))).toEqual({ followers: 1250, videos: 42 });
  });
  it("leaves out what the page does not carry", () => {
    expect(parseTikTokPage(page({ followerCount: "many" }))).toEqual({ followers: null, videos: null });
    expect(parseTikTokPage("<html>blocked</html>")).toEqual({ followers: null, videos: null });
  });
});
