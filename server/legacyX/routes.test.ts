import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueAccessToken } from "./auth";
import { createLegacyXRouter } from "./routes";

let server: Server;
let baseUrl: string;
const hasDatabaseIntegration = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const integrationIt = hasDatabaseIntegration ? it : it.skip;

async function frontendAuthHeaders() {
  const accessToken = await issueAccessToken({
    id: randomUUID(),
    steamId: "76561198000000000",
    username: "frontend-contract-user",
  });
  return { authorization: `Bearer ${accessToken}` };
}

beforeAll(async () => {
  process.env.JWT_SECRET ??= "test-only-secret-at-least-32-characters-long";
  process.env.STEAM_OPENID_ORIGIN ??= "https://legacyx.cc";
  process.env.FRONTEND_ORIGIN ??= "https://legacyx.cc";
  process.env.STAFF_PANEL_ENABLED = "true";
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createLegacyXRouter());
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
});

describe("LEGACY-X REST API", () => {
  integrationIt("returns the frontend leaderboard array for an authenticated user", async () => {
    const response = await fetch(`${baseUrl}/leaderboard?mode=5vs5`, { headers: await frontendAuthHeaders() });

    expect(response.status).toBe(200);
    const payload = await response.json() as unknown[];
    expect(Array.isArray(payload)).toBe(true);
  });

  it("uses the configured legacyx.cc Steam realm origin for the OpenID callback", async () => {
    const response = await fetch(`${baseUrl}/auth/steam`, { redirect: "manual" });

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.origin).toBe("https://steamcommunity.com");
    expect(redirect.searchParams.get("openid.return_to")).toBe(`${process.env.STEAM_OPENID_ORIGIN}/api/v1/auth/steam/callback`);
    expect(redirect.searchParams.get("openid.realm")).toBe(process.env.STEAM_OPENID_ORIGIN);
  });

  it("sends a player who cancelled on Steam back to the site instead of a JSON error", async () => {
    const response = await fetch(`${baseUrl}/auth/steam/callback?openid.mode=cancel`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${process.env.FRONTEND_ORIGIN}/?login=cancelled`);
  });

  it("starts the iOS app's Steam sign-in with its own callback and sends a cancel back to the app", async () => {
    const begin = await fetch(`${baseUrl}/auth/steam/app`, { redirect: "manual" });
    expect(begin.status).toBe(302);
    const redirect = new URL(begin.headers.get("location")!);
    expect(redirect.searchParams.get("openid.return_to")).toBe(`${process.env.STEAM_OPENID_ORIGIN}/api/v1/auth/steam/app/callback`);

    const cancelled = await fetch(`${baseUrl}/auth/steam/app/callback?openid.mode=cancel`, { redirect: "manual" });
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.get("location")).toBe("legacyx://auth?error=cancelled");

    const failed = await fetch(`${baseUrl}/auth/steam/app/callback?openid.mode=id_res&openid.claimed_id=https://example.com/not-steam`, { redirect: "manual" });
    expect(failed.headers.get("location")).toBe("legacyx://auth?error=failed");
  });

  it("refuses an app sign-in code that was never issued", async () => {
    const response = await fetch(`${baseUrl}/auth/app/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "a".repeat(48) }) });
    expect(response.status).toBe(401);
  });

  it("sends a failed Steam login back to the site with a short code", async () => {
    const response = await fetch(`${baseUrl}/auth/steam/callback?openid.mode=id_res&openid.claimed_id=https://example.com/not-steam`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${process.env.FRONTEND_ORIGIN}/?login=failed`);
  });

  it("allows only the configured legacyx.cc frontend origin to make credentialed API requests", async () => {
    const response = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { origin: process.env.FRONTEND_ORIGIN! },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(process.env.FRONTEND_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("returns hardened headers and a JSON 404 for unknown API paths", async () => {
    const response = await fetch(`${baseUrl}/not-a-real-route`);

    expect(response.status).toBe(404);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    await expect(response.json()).resolves.toEqual({ error: "API route not found" });
  });

  it("rejects plugin writes without a bearer token before any database write", async () => {
    const response = await fetch(`${baseUrl}/plugin/servers/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "de_test", label: "Test" }),
    });

    expect(response.status).toBe(401);
  });

	it("rejects live snapshot writes without a scoped plugin token before any database write", async () => {
		const response = await fetch(`${baseUrl}/plugin/live-match/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "snapshot-test-event-0001",
        server_id: "legacyx-match-1",
        live_match: { schema_version: 1, snapshot_revision: 1, captured_at: "2026-08-24T15:00:00.000Z", state: "live", terrorist_players: [], counter_terrorist_players: [], spectator_players: [] },
      }),
    });

		expect(response.status).toBe(401);
	});

		it("rejects central ban writes, lifts and checks without a plugin token before any database access", async () => {
			const ban = { steamId: "76561198000000001", durationMinutes: 1440, reason: "wallhack", issuerName: "staff (Discord)" };
			for (const [path, body] of [["/plugin/bans", ban], ["/plugin/bans/revoke", { steamId: ban.steamId, issuerName: ban.issuerName }], ["/plugin/bans/check", { steamIds: [ban.steamId] }], ["/plugin/discord/checks", { discordId: "123456789012345678", steamId: ban.steamId }]] as const) {
				const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
				expect(response.status, path).toBe(401);
			}
		});

		it("rejects in-game staff authorization lookups without a scoped plugin token before any database read", async () => {
			const response = await fetch(`${baseUrl}/plugin/admin/authorizations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serverId: "srv-1", steamIds: ["76561198000000001"] }) });
			expect(response.status).toBe(401);
		});

		it("rejects staffpanel reads, governance configuration and queued actions without the isolated staff session", async () => {
    const [accessResponse, staffResponse, actionResponse] = await Promise.all([
      fetch(`${baseUrl}/staffpanel/access`),
      fetch(`${baseUrl}/staffpanel/staff`),
      fetch(`${baseUrl}/staffpanel/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "legacyx-match-1",
          type: "ban",
          playerSteamId: "76561198000000000",
          message: "contract test",
        }),
      }),
    ]);

    expect(accessResponse.status).toBe(401);
    expect(staffResponse.status).toBe(401);
    expect(actionResponse.status).toBe(401);
  });

  integrationIt("rejects an invalid plugin bearer token before any database write", async () => {
    const response = await fetch(`${baseUrl}/plugin/servers/heartbeat`, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-plugin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "de_test", label: "Test" }),
    });

    expect(response.status).toBe(403);
  });

  integrationIt("keeps an atomic purchase from writing when the requested item does not exist", async () => {
    const accessToken = await issueAccessToken({
      id: randomUUID(),
      steamId: "76561198000000000",
      username: "transaction-guard",
      role: "Player",
    });
    const response = await fetch(`${baseUrl}/store/items/${randomUUID()}/purchase`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(404);
  });
});
