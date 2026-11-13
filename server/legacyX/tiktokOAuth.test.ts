import { describe, expect, it } from "vitest";
import { cleanTikTokUsername, fetchTikTokProfile, isTikTokState, tiktokAuthorizeUrl, tiktokConfig } from "./tiktokOAuth";

const config = { clientKey: "awabcdefghijklmn", clientSecret: "secret", redirectUri: "https://api.legacyx.cc/api/v1/auth/tiktok/callback" };

describe("TikTok settings", () => {
  it("needs all three settings and an https redirect", () => {
    expect(tiktokConfig({ TIKTOK_CLIENT_KEY: config.clientKey, TIKTOK_CLIENT_SECRET: "s", TIKTOK_REDIRECT_URI: config.redirectUri } as NodeJS.ProcessEnv)).toMatchObject({ clientKey: config.clientKey });
    expect(tiktokConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(tiktokConfig({ TIKTOK_CLIENT_KEY: config.clientKey, TIKTOK_CLIENT_SECRET: "s", TIKTOK_REDIRECT_URI: "http://insecure" } as NodeJS.ProcessEnv)).toBeNull();
  });
  it("asks for the three profile scopes and carries the state, never the secret", () => {
    const url = new URL(tiktokAuthorizeUrl(config, "STATE"));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,user.info.profile,user.info.stats");
    expect(url.searchParams.get("client_key")).toBe(config.clientKey);
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("client_secret")).toBeNull();
  });
  it("accepts only our own 32-character states and plain handles", () => {
    expect(isTikTokState("a".repeat(32))).toBe(true);
    expect(isTikTokState("short")).toBe(false);
    expect(cleanTikTokUsername("legacy.x_1")).toBe("legacy.x_1");
    expect(cleanTikTokUsername("bad name<script>")).toBe("");
  });
});

describe("TikTok profile", () => {
  const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
  it("reads who the account is and its numbers", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return String(input).includes("/oauth/token/")
        ? reply({ access_token: "tok", open_id: "open-1" })
        : reply({ data: { user: { open_id: "open-1", username: "legacyx", display_name: "LEGACY-X", avatar_url: "https://p16.tiktokcdn.com/a.jpeg", follower_count: 1200, likes_count: 3400, video_count: 15 } } });
    }) as typeof fetch;
    await expect(fetchTikTokProfile(config, "code", fetcher)).resolves.toEqual({ openId: "open-1", username: "legacyx", displayName: "LEGACY-X", avatarUrl: "https://p16.tiktokcdn.com/a.jpeg", followers: 1200, likes: 3400, videos: 15 });
    expect(calls[0]).toBe("https://open.tiktokapis.com/v2/oauth/token/");
  });
  it("refuses a rejected code, a missing token and an account that does not match", async () => {
    await expect(fetchTikTokProfile(config, "bad", (async () => reply({}, false)) as typeof fetch)).rejects.toThrow("did not accept");
    await expect(fetchTikTokProfile(config, "x", (async () => reply({ error: "x" })) as typeof fetch)).rejects.toThrow("no access token");
    const mismatch = (async (input: RequestInfo | URL) => (String(input).includes("/oauth/token/") ? reply({ access_token: "t", open_id: "a" }) : reply({ data: { user: { open_id: "b" } } }))) as typeof fetch;
    await expect(fetchTikTokProfile(config, "x", mismatch)).rejects.toThrow("unexpected");
  });
});
