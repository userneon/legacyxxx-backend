import { describe, expect, it } from "vitest";
import { AD_PRICES, creatorAdDecisionSchema, creatorAdSchema, creatorTikTokHandle, oembedHandle, parseTikTokVideoUrl, trustedImageHost } from "./creatorAds";

describe("creator ads", () => {
  it("prices: 24 h is 5,000 and 48 h is 8,000", () => {
    expect(AD_PRICES[24]).toBe(5000);
    expect(AD_PRICES[48]).toBe(8000);
  });
  it("takes only the canonical TikTok video link", () => {
    // a tracking query is dropped: the stored link is always the clean one
    expect(parseTikTokVideoUrl("https://www.tiktok.com/@LXC.mn/video/7301234567890123456?is_from_webapp=1")?.url).toBe("https://www.tiktok.com/@LXC.mn/video/7301234567890123456");
    expect(parseTikTokVideoUrl("https://www.tiktok.com/@LXC.mn/video/7301234567890123456")).toEqual({ url: "https://www.tiktok.com/@LXC.mn/video/7301234567890123456", handle: "@lxc.mn", videoId: "7301234567890123456" });
    expect(parseTikTokVideoUrl("https://vm.tiktok.com/ZMabc/")).toBeNull();
    expect(parseTikTokVideoUrl("http://www.tiktok.com/@a_b/video/7301234567890123456")).toBeNull();
    expect(parseTikTokVideoUrl("https://evil.com/@a_b/video/7301234567890123456")).toBeNull();
    expect(parseTikTokVideoUrl("https://www.tiktok.com/@a_b")).toBeNull();
  });
  it("fetches pictures only from TikTok's own hosts", () => {
    expect(trustedImageHost("p16-sign.tiktokcdn-us.com")).toBe(true);
    expect(trustedImageHost("p19-sign-va.tiktokcdn.com")).toBe(true);
    expect(trustedImageHost("evil.example.com")).toBe(false);
    expect(trustedImageHost("tiktokcdn.com.evil.com")).toBe(false);
    expect(trustedImageHost("169.254.169.254")).toBe(false);
  });
  it("reads the handle of an author link and of a saved profile link", () => {
    expect(oembedHandle("https://www.tiktok.com/@LXC.mn")).toBe("@lxc.mn");
    expect(oembedHandle("not a link")).toBeNull();
    expect(creatorTikTokHandle("https://www.tiktok.com/@lxc.mn")).toBe("@lxc.mn");
    expect(creatorTikTokHandle("tiktok.com/@lxc.mn")).toBe("@lxc.mn");
    expect(creatorTikTokHandle("https://example.com/@lxc.mn")).toBeNull();
    expect(creatorTikTokHandle(undefined)).toBeNull();
  });
  it("validates the request and the decision", () => {
    expect(creatorAdSchema.safeParse({ url: "https://www.tiktok.com/@a_b/video/7301234567890123456", hours: 24 }).success).toBe(true);
    expect(creatorAdSchema.safeParse({ url: "https://www.tiktok.com/@a_b/video/7301234567890123456", hours: 12 }).success).toBe(false);
    expect(creatorAdDecisionSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(creatorAdDecisionSchema.safeParse({ decision: "maybe" }).success).toBe(false);
  });
});
