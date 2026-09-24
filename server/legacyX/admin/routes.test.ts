import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLegacyXRouter } from "../routes";

type Endpoint = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string };

const steam = "76561198000000001";
const id = "00000000-0000-4000-8000-000000000009";

// Staff endpoints: a request without an access token must never reach the database.
const staffEndpoints: Endpoint[] = [
  { method: "GET", path: "/users/me" },
  { method: "GET", path: "/admin/badge" },
  { method: "GET", path: "/admin/dashboard" },
  { method: "GET", path: "/admin/search?q=test" },
  { method: "GET", path: "/admin/live" },
  { method: "GET", path: "/admin/servers" },
  { method: "POST", path: "/admin/servers" },
  { method: "POST", path: `/admin/servers/${id}/rotate-key` },
  { method: "POST", path: `/admin/servers/${id}/delete` },
  { method: "GET", path: `/admin/servers/${id}` },
  { method: "GET", path: `/admin/servers/${id}/recent` },
  { method: "GET", path: `/admin/servers/${id}/chat` },
  { method: "GET", path: `/admin/servers/${id}/actions` },
  { method: "POST", path: `/admin/servers/${id}/commands` },
  { method: "GET", path: "/admin/matches/LX-1" },
  { method: "GET", path: `/players/${steam}/moderation` },
  { method: "GET", path: `/players/${steam}/moderation/punishments` },
  { method: "POST", path: `/players/${steam}/notes` },
  { method: "POST", path: `/admin/players/${steam}/kick` },
  { method: "GET", path: "/admin/bans" },
  { method: "POST", path: "/admin/bans" },
  { method: "PATCH", path: `/admin/bans/${id}` },
  { method: "POST", path: `/admin/bans/${id}/revoke` },
  { method: "GET", path: "/admin/review-queue" },
  { method: "POST", path: `/admin/review-queue/${id}` },
  { method: "GET", path: "/admin/mutes" },
  { method: "POST", path: "/admin/mutes" },
  { method: "POST", path: `/admin/mutes/${id}/revoke` },
  { method: "GET", path: "/admin/appeals" },
  { method: "POST", path: `/admin/appeals/${id}` },
  { method: "GET", path: "/appeals/me" },
  { method: "POST", path: "/appeals" },
  { method: "GET", path: "/admin/reports" },
  { method: "POST", path: `/admin/reports/${id}` },
  { method: "GET", path: "/admin/audit" },
  { method: "GET", path: "/admin/roles" },
  { method: "POST", path: "/admin/roles/admin/members" },
  { method: "POST", path: `/admin/roles/admin/members/${steam}/remove` },
  { method: "PUT", path: "/admin/roles/admin/permissions" },
  { method: "PUT", path: "/admin/roles/admin/immunity" },
  { method: "GET", path: "/admin/products" },
  { method: "POST", path: "/admin/products" },
  { method: "GET", path: "/admin/announcements" },
  { method: "GET", path: "/admin/site-config" },
  { method: "POST", path: "/admin/site-config" },
  { method: "POST", path: "/admin/site-config/1/rollback" },
  { method: "GET", path: "/admin/name-filters" },
  { method: "POST", path: "/admin/name-filters" },
  { method: "GET", path: "/admin/reauth/status" },
];

// Game endpoints: a request without a server API key must be refused.
const gameEndpoints: Endpoint[] = [
  { method: "POST", path: "/game/heartbeat" },
  { method: "GET", path: `/game/permissions/${steam}` },
  { method: "POST", path: "/game/actions" },
  { method: "GET", path: "/game/queue" },
  { method: "POST", path: `/game/queue/${id}` },
  { method: "POST", path: "/game/sessions/connect" },
  { method: "POST", path: "/game/sessions/disconnect" },
  { method: "POST", path: "/game/names" },
  { method: "POST", path: "/game/chat" },
  { method: "POST", path: "/game/reports" },
  { method: "GET", path: "/game/announcements" },
];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.JWT_SECRET ??= "test-secret-for-vitest-0123456789";
  const app = express();
  app.use("/api/v1", express.json(), createLegacyXRouter());
  server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function call(endpoint: Endpoint, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${endpoint.path}`, {
    method: endpoint.method,
    headers: { "content-type": "application/json", ...headers },
    body: endpoint.method === "GET" ? undefined : "{}",
  });
}

describe("admin API guards", () => {
  it.each(staffEndpoints)("$method $path requires a signed-in user", async endpoint => {
    const response = await call(endpoint);
    expect(response.status).toBe(401);
  });

  it.each(staffEndpoints)("$method $path rejects a forged token", async endpoint => {
    const response = await call(endpoint, { authorization: "Bearer not-a-real-token" });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it.each(gameEndpoints)("$method $path requires a game server key", async endpoint => {
    expect((await call(endpoint)).status).toBe(401);
    expect((await call(endpoint, { "x-server-key": "lxs_short" })).status).toBe(401);
  });

  it("role changes are never reachable with a plugin token either", async () => {
    const response = await call({ method: "PUT", path: "/admin/roles/owner/permissions" }, { "x-plugin-secret": "anything" });
    expect(response.status).toBe(401);
  });
});

describe("existing routes keep working", () => {
  it("passes non-SteamID player lookups through instead of treating them as staff lookups", async () => {
    const response = await call({ method: "GET", path: "/players/00000000-0000-4000-8000-000000000004" });
    // The legacy uuid player route was removed; the admin router must not claim the request.
    expect(response.status).toBe(404);
  });

  it("keeps the reauth Steam redirect on the admin path and away from /auth", async () => {
    process.env.STEAM_OPENID_ORIGIN = "https://api.example.test";
    const response = await fetch(`${baseUrl}/admin/reauth/steam?returnTo=/panel/staff`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.hostname).toBe("steamcommunity.com");
    expect(location.searchParams.get("openid.return_to")).toBe("https://api.example.test/api/v1/admin/reauth/steam/callback?returnTo=%2Fpanel%2Fstaff");
  });

  it("refuses open redirects in returnTo", async () => {
    process.env.STEAM_OPENID_ORIGIN = "https://api.example.test";
    const response = await fetch(`${baseUrl}/admin/reauth/steam?returnTo=https://evil.test`, { redirect: "manual" });
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("openid.return_to")).toContain("returnTo=%2Fpanel%2Fstaff");
  });
});
