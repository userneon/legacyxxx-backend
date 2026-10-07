import { describe, expect, it } from "vitest";
import { authorizeUrl, discordOAuthConfig, fetchDiscordIdentity, isOAuthState } from "./discordOAuth";

const config = { clientId: "123456789012345678", clientSecret: "secret", redirectUri: "https://api.legacyx.cc/api/v1/auth/discord/callback" };

describe("Discord OAuth settings", () => {
  it("needs all three settings, a numeric client id and an https redirect", () => {
    expect(discordOAuthConfig({ DISCORD_OAUTH_CLIENT_ID: config.clientId, DISCORD_OAUTH_CLIENT_SECRET: "s", DISCORD_OAUTH_REDIRECT_URI: config.redirectUri } as NodeJS.ProcessEnv)).toMatchObject({ clientId: config.clientId });
    expect(discordOAuthConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(discordOAuthConfig({ DISCORD_OAUTH_CLIENT_ID: "abc", DISCORD_OAUTH_CLIENT_SECRET: "s", DISCORD_OAUTH_REDIRECT_URI: config.redirectUri } as NodeJS.ProcessEnv)).toBeNull();
    expect(discordOAuthConfig({ DISCORD_OAUTH_CLIENT_ID: config.clientId, DISCORD_OAUTH_CLIENT_SECRET: "s", DISCORD_OAUTH_REDIRECT_URI: "http://insecure" } as NodeJS.ProcessEnv)).toBeNull();
  });
  it("asks Discord for the identify scope only and carries the state", () => {
    const url = new URL(authorizeUrl(config, "STATE"));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("client_secret")).toBeNull();
  });
  it("accepts only our own 32-character states", () => {
    expect(isOAuthState("a".repeat(32))).toBe(true);
    expect(isOAuthState("short")).toBe(false);
    expect(isOAuthState("a".repeat(31) + "!")).toBe(false);
    expect(isOAuthState(undefined)).toBe(false);
  });
});

describe("Discord identity", () => {
  const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
  it("reads who the account is and prefers the display name", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return String(input).endsWith("/token") ? reply({ access_token: "tok" }) : reply({ id: "987654321098765432", username: "legacy", global_name: "Legacy Player" });
    }) as typeof fetch;
    await expect(fetchDiscordIdentity(config, "code", fetcher)).resolves.toEqual({ id: "987654321098765432", name: "Legacy Player" });
    expect(calls).toEqual(["https://discord.com/api/oauth2/token", "https://discord.com/api/users/@me"]);
  });
  it("refuses a code Discord rejects and an answer without a real id", async () => {
    await expect(fetchDiscordIdentity(config, "bad", (async () => reply({}, false)) as typeof fetch)).rejects.toThrow();
    const odd = (async (input: RequestInfo | URL) => (String(input).endsWith("/token") ? reply({ access_token: "tok" }) : reply({ id: "x" }))) as typeof fetch;
    await expect(fetchDiscordIdentity(config, "code", odd)).rejects.toThrow();
  });
});
