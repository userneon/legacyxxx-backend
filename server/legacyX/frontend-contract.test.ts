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
  { method: "GET", path: "/play/matches" }, { method: "GET", path: "/play/matches/00000000-0000-4000-8000-000000000002" }, { method: "POST", path: "/play/matches/00000000-0000-4000-8000-000000000002/join" }, { method: "POST", path: "/play/matches/00000000-0000-4000-8000-000000000002/favorite" },
  { method: "GET", path: "/servers" }, { method: "GET", path: "/servers/00000000-0000-4000-8000-000000000003" }, { method: "POST", path: "/servers/00000000-0000-4000-8000-000000000003/join" }, { method: "GET", path: "/servers/home-stats" },
  { method: "GET", path: "/leaderboard" }, { method: "GET", path: "/players/00000000-0000-4000-8000-000000000004" }, { method: "GET", path: "/players/leaderboard" },
  { method: "GET", path: "/clans" }, { method: "GET", path: "/clans/00000000-0000-4000-8000-000000000005" }, { method: "GET", path: "/clans/00000000-0000-4000-8000-000000000005/members" }, { method: "POST", path: "/clans" }, { method: "PUT", path: "/clans/00000000-0000-4000-8000-000000000005" }, { method: "POST", path: "/clans/00000000-0000-4000-8000-000000000005/join" }, { method: "POST", path: "/clans/00000000-0000-4000-8000-000000000005/leave" }, { method: "DELETE", path: "/clans/00000000-0000-4000-8000-000000000005" }, { method: "GET", path: "/clans/team" },
  { method: "GET", path: "/tournaments/matches" }, { method: "GET", path: "/tournaments/matches/00000000-0000-4000-8000-000000000006" }, { method: "GET", path: "/tournaments/bracket" }, { method: "GET", path: "/tournaments/info" }, { method: "POST", path: "/tournaments/register" },
  { method: "GET", path: "/store/items" }, { method: "GET", path: "/store/items/00000000-0000-4000-8000-000000000007" }, { method: "POST", path: "/store/items/00000000-0000-4000-8000-000000000007/purchase" },
  { method: "GET", path: "/wallet/balance" }, { method: "GET", path: "/wallet/transactions" }, { method: "POST", path: "/wallet/charge" },
  { method: "POST", path: "/wallet/promo/preview" }, { method: "POST", path: "/wallet/promo/redeem" }, { method: "GET", path: "/wallet/promotions" },
  { method: "GET", path: "/moderation/penalties" }, { method: "GET", path: "/penalties/00000000-0000-4000-8000-000000000008" }, { method: "GET", path: "/moderation/penalties/stats" },
  { method: "GET", path: "/feedback", public: true }, { method: "POST", path: "/feedback" }, { method: "GET", path: "/search/players?query=test" }, { method: "GET", path: "/search/clans?query=test" }, { method: "GET", path: "/community/content" },
];

const skinchangerEndpoints: Endpoint[] = [
  { method: "GET", path: "/skinchanger/catalog" },
  { method: "GET", path: "/skinchanger/catalog/facets" },
  { method: "GET", path: "/skinchanger/loadout" },
  { method: "GET", path: "/skinchanger/active-server" },
  { method: "PUT", path: "/skinchanger/loadout" },
  { method: "PUT", path: "/skinchanger/loadout/entry" },
  { method: "DELETE", path: "/skinchanger/loadout/entry" },
  { method: "POST", path: "/skinchanger/apply" },
  { method: "GET", path: "/skinchanger/status" },
];

const competitiveEndpoints: Endpoint[] = [
  { method: "GET", path: "/competitive/me/access" },
];

const reconnectEndpoints: Endpoint[] = [
  { method: "GET", path: "/reconnect/me" },
];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createLegacyXRouter());
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe("frontend API endpoint inventory", () => {
  it("contains the frontend endpoint inventory including authenticated wallet promotion routes", () => {
    expect(frontendEndpoints).toHaveLength(52);
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
