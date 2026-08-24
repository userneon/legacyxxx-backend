import { afterEach, describe, expect, it } from "vitest";
import { hasPluginScope, issueAccessToken, sha256, steamLoginUrl, verifyAccessToken, verifySteamCallback } from "./auth";

const originalJwtSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

describe("plugin token hashing", () => {
  it("uses a deterministic SHA-256 digest and does not preserve the raw token", () => {
    const token = "plugin-secret-token";
    expect(sha256(token)).toBe("9473c6ea8c49e57975992da8d925d133e11f0da11f990cae12f57c1f8752ddd5");
    expect(sha256(token)).not.toContain(token);
  });

  it("allows only explicitly granted plugin scopes", () => {
    expect(hasPluginScope(["matches:write", "stats:write"], "matches:write")).toBe(true);
    expect(hasPluginScope(["matches:write"], "community:write")).toBe(false);
    expect(hasPluginScope("matches:write", "matches:write")).toBe(false);
  });

  it("issues and verifies a signed user access token", async () => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    const token = await issueAccessToken({ id: "player-id", steamId: "76561198000000000", username: "Player", role: "Player" });

    await expect(verifyAccessToken(token)).resolves.toEqual({ id: "player-id", steamId: "76561198000000000", username: "Player", role: "Player" });
    await expect(verifyAccessToken(`${token}tampered`)).rejects.toThrow();
  });

  it("creates an API-subdomain Steam return URL and rejects malformed callback identities before network verification", async () => {
    const redirect = new URL(steamLoginUrl("https://api.legacyx.cc"));
    expect(redirect.searchParams.get("openid.return_to")).toBe("https://api.legacyx.cc/api/v1/auth/steam/callback");

    await expect(verifySteamCallback({ "openid.claimed_id": "https://invalid.example/123" })).rejects.toMatchObject({ statusCode: 401 });
  });
});
