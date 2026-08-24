import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueAccessToken } from "./auth";
import { createLegacyXRouter } from "./routes";

let server: Server;
let baseUrl: string;

async function frontendAuthHeaders() {
  const accessToken = await issueAccessToken({
    id: randomUUID(),
    steamId: "76561198000000000",
    username: "frontend-contract-user",
    role: "Player",
  });
  return { authorization: `Bearer ${accessToken}` };
}

beforeAll(async () => {
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
  it("returns the frontend leaderboard array for an authenticated user", async () => {
    const response = await fetch(`${baseUrl}/leaderboard?mode=5vs5`, { headers: await frontendAuthHeaders() });

    expect(response.status).toBe(200);
    const payload = await response.json() as unknown[];
    expect(Array.isArray(payload)).toBe(true);
  });

  it("rejects unsupported frontend leaderboard modes after authentication", async () => {
    const response = await fetch(`${baseUrl}/leaderboard?mode=unsupported`, { headers: await frontendAuthHeaders() });

    expect(response.status).toBe(400);
  });

  it("uses the configured legacyx.cc Steam realm origin for the OpenID callback", async () => {
    const response = await fetch(`${baseUrl}/auth/steam`, { redirect: "manual" });

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.origin).toBe("https://steamcommunity.com");
    expect(redirect.searchParams.get("openid.return_to")).toBe(`${process.env.STEAM_OPENID_ORIGIN}/api/v1/auth/steam/callback`);
    expect(redirect.searchParams.get("openid.realm")).toBe(process.env.STEAM_OPENID_ORIGIN);
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
    const response = await fetch(`${baseUrl}/plugin/maps`, {
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

  it("rejects an invalid plugin bearer token before any database write", async () => {
    const response = await fetch(`${baseUrl}/plugin/maps`, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-plugin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "de_test", label: "Test" }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects community writes without a scoped plugin token before an audit record can be created", async () => {
    const response = await fetch(`${baseUrl}/community/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "partner", name: "Unauthorized", url: "https://example.invalid" }),
    });

    expect(response.status).toBe(401);
  });

  it("keeps an atomic purchase from writing when the requested item does not exist", async () => {
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
