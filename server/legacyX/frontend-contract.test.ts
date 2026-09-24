import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLegacyXRouter } from "./routes";

type Endpoint = { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; public?: boolean };

// pasted_content_5.txt names 49 frontend endpoints, despite the request text calling them 62.
const frontendEndpoints: Endpoint[] = [
  { method: "GET", path: "/auth/steam", public: true },
  { method: "POST", path: "/auth/logout" }, { method: "POST", path: "/auth/refresh" }, { method: "GET", path: "/auth/me" },
  { method: "GET", path: "/profile/00000000-0000-4000-8000-000000000001" }, { method: "PUT", path: "/profile/me" }, { method: "GET", path: "/profile/me/stats" }, { method: "GET", path: "/profile/me/matches" }, { method: "PUT", path: "/profile/me/links" }, { method: "GET", path: "/profile/me/penalties" },
  { method: "GET", path: "/public/servers", public: true }, { method: "POST", path: "/public/servers/legacyx-match-1/join", public: true }, { method: "GET", path: "/play/5v5/quick-join", public: true }, { method: "GET", path: "/public/killfeed", public: true },
  { method: "GET", path: "/tournaments", public: true }, { method: "GET", path: "/tournaments/00000000-0000-4000-8000-000000000006", public: true },
  { method: "POST", path: "/tournaments/00000000-0000-4000-8000-000000000006/register" }, { method: "POST", path: "/tournaments/00000000-0000-4000-8000-000000000006/check-in" }, { method: "POST", path: "/tournaments/00000000-0000-4000-8000-000000000006/teams/00000000-0000-4000-8000-000000000007/join" }, { method: "DELETE", path: "/tournaments/00000000-0000-4000-8000-000000000006/registration" },
  { method: "GET", path: "/moderation/penalties", public: true }, { method: "GET", path: "/penalties/00000000-0000-4000-8000-000000000008", public: true }, { method: "GET", path: "/moderation/penalties/stats", public: true },
  { method: "GET", path: "/notifications" }, { method: "POST", path: "/notifications/read" }, { method: "DELETE", path: "/notifications" },
  { method: "GET", path: "/feedback", public: true }, { method: "POST", path: "/feedback" }, { method: "GET", path: "/search/players?query=test", public: true }, { method: "GET", path: "/community/content", public: true },
  { method: "GET", path: "/public/ranked-matches/00000000-0000-4000-8000-000000000009", public: true }, { method: "GET", path: "/public/competitive/players/00000000-0000-4000-8000-000000000001/matches", public: true },
];

const skinchangerEndpoints: Endpoint[] = [
  { method: "GET", path: "/skinchanger/catalog" },
  { method: "GET", path: "/skinchanger/catalog/facets" },
  { method: "GET", path: "/skinchanger/loadout" },
  { method: "PUT", path: "/skinchanger/loadout" },
  { method: "PUT", path: "/skinchanger/loadout/entry" },
  { method: "DELETE", path: "/skinchanger/loadout/entry" },
];

const competitiveEndpoints: Endpoint[] = [
  { method: "GET", path: "/competitive/me/access" },
];

const reconnectEndpoints: Endpoint[] = [
  { method: "GET", path: "/reconnect/me" },
];

const staffPanelEndpoints: Endpoint[] = [
  { method: "GET", path: "/staffpanel/access" },
  { method: "GET", path: "/staffpanel/overview" },
  { method: "GET", path: "/staffpanel/database" },
  { method: "POST", path: "/staffpanel/actions" },
];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.STAFF_PANEL_ENABLED = "true";
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createLegacyXRouter());
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe("frontend API endpoint inventory", () => {
  it("fails closed for deferred public feature APIs and exposes only launch booleans", async () => {
    const previous = Object.fromEntries(["STAFF_PANEL_ENABLED"].map(name => [name, process.env[name]]));
    Object.assign(process.env, { STAFF_PANEL_ENABLED: "false" });
    try {
      const featureResponse = await fetch(`${baseUrl}/public/features`);
      await expect(featureResponse.json()).resolves.toEqual({ features: { staffPanel: false } });
      for (const path of ["/staffpanel/access"]) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status, path).toBe(404);
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it("contains the frontend endpoint inventory", () => {
    expect(frontendEndpoints).toHaveLength(32);
  });

  it("no longer serves the removed clan and seasonal rank APIs", async () => {
    for (const path of ["/clans", "/search/clans?query=test", "/public/rank/leaderboard", "/public/community/experience", "/play/matches", "/servers/home-stats", "/leaderboard"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it("serves public read pages to guests without demanding authentication", async () => {
    for (const endpoint of frontendEndpoints.filter(endpoint => endpoint.public && endpoint.path !== "/auth/steam")) {
      const response = await fetch(`${baseUrl}${endpoint.path}`, { method: endpoint.method });
      expect(response.status, `${endpoint.method} /api/v1${endpoint.path}`).not.toBe(401);
    }
  });

  it("registers every protected contract endpoint beneath /api/v1 and rejects missing authentication", async () => {
    for (const endpoint of frontendEndpoints.filter(endpoint => !endpoint.public)) {
      const response = await fetch(`${baseUrl}${endpoint.path}`, {
        method: endpoint.method,
        headers: endpoint.method === "GET" || endpoint.method === "DELETE" ? undefined : { "content-type": "application/json" },
        body: endpoint.method === "GET" || endpoint.method === "DELETE" ? undefined : "{}",
      });
      expect(response.status, `${endpoint.method} /api/v1${endpoint.path}`).toBe(401);
    }
  });

  it("registers each production Skinchanger user endpoint and rejects missing authentication", async () => {
    for (const endpoint of skinchangerEndpoints) {
      const response = await fetch(`${baseUrl}${endpoint.path}`, {
        method: endpoint.method,
        headers: endpoint.method === "GET" ? undefined : { "content-type": "application/json" },
        body: endpoint.method === "GET" ? undefined : "{}",
      });
      expect(response.status, `${endpoint.method} /api/v1${endpoint.path}`).toBe(401);
    }
  });

  it("registers competitive player access beneath /api/v1 and rejects missing authentication", async () => {
    for (const endpoint of competitiveEndpoints) {
      const response = await fetch(`${baseUrl}${endpoint.path}`, { method: endpoint.method });
      expect(response.status, `${endpoint.method} /api/v1${endpoint.path}`).toBe(401);
    }
  });

  it("registers the authenticated player reconnect endpoint and rejects missing authentication", async () => {
    for (const endpoint of reconnectEndpoints) {
      const response = await fetch(`${baseUrl}${endpoint.path}`, { method: endpoint.method });
      expect(response.status, `${endpoint.method} /api/v1${endpoint.path}`).toBe(401);
    }
  });

  it("registers all staffpanel routes and rejects unauthenticated requests", async () => {
    for (const endpoint of staffPanelEndpoints) {
      const response = await fetch(`${baseUrl}${endpoint.path}`, {
        method: endpoint.method,
        headers: endpoint.method === "GET" ? undefined : { "content-type": "application/json" },
        body: endpoint.method === "GET" ? undefined : "{}",
      });
      expect(response.status, `${endpoint.method} /api/v1${endpoint.path}`).toBe(401);
    }
  });

  it("registers the public competitive leaderboard route", async () => {
    const response = await fetch(`${baseUrl}/public/competitive/leaderboard`);
    expect(response.status).not.toBe(404);
  });

  it("registers the public server live match route", async () => {
    const response = await fetch(`${baseUrl}/public/servers/legacyx-match-1/live-match`);
    expect(response.status).not.toBe(404);
  });

  it("registers the public Steam entry point beneath /api/v1", async () => {
    const response = await fetch(`${baseUrl}/auth/steam`, { redirect: "manual" });
    expect(response.status).toBe(302);
  });
});
