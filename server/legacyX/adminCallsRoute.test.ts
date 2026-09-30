import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The routes run for real; only the database and the token check are replaced.
type Query = { table: string; op: "select" | "insert"; payload?: Record<string, unknown>; filters: Array<[string, string, unknown]>; single: boolean };
const runs: Query[] = [];
let recentRows: Array<{ id: number }> = [];
let listedRows: Array<Record<string, unknown>> = [];
let newestRows: Array<{ id: number }> = [];

vi.mock("./supabase", async (importActual) => {
  const actual = await importActual<typeof import("./supabase")>();
  const result = (query: Query) => {
    runs.push(query);
    if (query.table === "audit_logs") return { data: null, error: null };
    if (query.op === "insert") return { data: { id: 9 }, error: null };
    if (query.filters.some(([op]) => op === "gt")) return { data: listedRows, error: null };
    if (query.filters.some(([, column]) => column === "caller_steam_id")) return { data: recentRows, error: null };
    return { data: newestRows, error: null };
  };
  const from = (table: string) => {
    const query: Query = { table, op: "select", filters: [], single: false };
    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (payload: Record<string, unknown>) => { query.op = "insert"; query.payload = payload; return builder; },
      eq: (column: string, value: unknown) => { query.filters.push(["eq", column, value]); return builder; },
      gt: (column: string, value: unknown) => { query.filters.push(["gt", column, value]); return builder; },
      gte: (column: string, value: unknown) => { query.filters.push(["gte", column, value]); return builder; },
      order: () => builder,
      limit: () => builder,
      single: () => { query.single = true; return builder; },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result(query)).then(resolve, reject),
    };
    return builder;
  };
  return { ...actual, legacyXDb: () => ({ from }) };
});

const SCOPES: Record<string, string[]> = { game: ["bans:write", "servers:write"], bot: ["discord:link", "bans:write"], other: ["stats:write"] };
vi.mock("./auth", async (importActual) => {
  const actual = await importActual<typeof import("./auth")>();
  return {
    ...actual,
    authenticatePlugin: async (rawToken: string, scope: string) => {
      const scopes = SCOPES[rawToken];
      if (!scopes?.includes(scope)) throw Object.assign(new Error("Plugin token is invalid or missing the required scope"), { statusCode: 403 });
      return { id: `token-${rawToken}`, name: rawToken, scopes };
    },
  };
});

const { createLegacyXRouter } = await import("./routes");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createLegacyXRouter());
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
  runs.length = 0;
  recentRows = [];
  listedRows = [];
  newestRows = [];
});

const call = { callerSteamId: "76561198000000001", callerName: "Temuulen", target: "admin", serverId: "srv-27015", map: "de_mirage", players: 8, onlineStaff: 0 };
const post = (token: string | null, body: unknown) => fetch(`${baseUrl}/plugin/admin-calls`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const get = (token: string | null, query = "") => fetch(`${baseUrl}/plugin/admin-calls${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const inserts = () => runs.filter((run) => run.op === "insert" && run.table === "admin_calls");

describe("POST /plugin/admin-calls", () => {
  it("records a request from a game server and audits it", async () => {
    const response = await post("game", call);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ recorded: true, id: 9 });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].payload).toMatchObject({ caller_steam_id: call.callerSteamId, target: "admin", server_id: "srv-27015", map: "de_mirage", online_staff: 0 });
    expect(runs.some((run) => run.table === "audit_logs" && run.op === "insert")).toBe(true);
  });

  it("ignores the same caller again inside the cooldown", async () => {
    recentRows = [{ id: 3 }];
    const response = await post("game", call);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: false, reason: "cooldown" });
    expect(inserts()).toHaveLength(0);
  });

  it("records a report with who and why, and only skips the same player inside the cooldown", async () => {
    const report = { ...call, target: "report", reportedSteamId: "76561198000000002", reportedName: "Cheater", reason: "wallhack", onlineStaff: undefined };
    const response = await post("game", report);
    expect(response.status).toBe(201);
    expect(inserts()[0].payload).toMatchObject({ target: "report", reported_steam_id: "76561198000000002", reported_name: "Cheater", reason: "wallhack", online_staff: 0 });
    const check = runs.find((run) => run.op === "select" && run.table === "admin_calls");
    expect(check?.filters).toEqual(expect.arrayContaining([["eq", "target", "report"], ["eq", "reported_steam_id", "76561198000000002"]]));
    expect((await post("game", { ...report, reason: undefined })).status).toBe(400);
  });

  it("rejects a bad request and a token without the scope, before any write", async () => {
    expect((await post("game", { ...call, callerSteamId: "STEAM_0:1:1" })).status).toBe(400);
    expect((await post("game", { ...call, target: "owner" })).status).toBe(400);
    expect((await post("other", call)).status).toBe(403);
    expect((await post(null, call)).status).toBeGreaterThanOrEqual(401);
    expect(inserts()).toHaveLength(0);
  });
});

describe("GET /plugin/admin-calls", () => {
  it("only reports where the feed stands when the bot gives no id", async () => {
    newestRows = [{ id: 12 }];
    const response = await get("bot");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ calls: [], latestId: 12 });
    expect(runs.some((run) => run.filters.some(([op]) => op === "gt"))).toBe(false);
  });

  it("returns the newer requests as the bot reads them", async () => {
    newestRows = [{ id: 5 }];
    listedRows = [{ id: 4, caller_steam_id: call.callerSteamId, caller_name: "Temuulen", target: "manager", server_id: "srv-27015", server_name: null, map: "de_mirage", players: 8, online_staff: 0, created_at: "2026-09-30T10:00:00Z" }];
    const response = await get("bot", "?after=3");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      calls: [{ id: 4, callerSteamId: call.callerSteamId, callerName: "Temuulen", target: "manager", reportedSteamId: null, reportedName: null, reason: null, serverId: "srv-27015", serverName: null, map: "de_mirage", players: 8, onlineStaff: 0, createdAt: "2026-09-30T10:00:00Z" }],
      latestId: 5,
    });
    const query = runs.find((run) => run.filters.some(([op, column, value]) => op === "gt" && column === "id" && value === 3));
    expect(query).toBeTruthy();
  });

  it("is for the bot only: a game server token is refused", async () => {
    expect((await get("game", "?after=0")).status).toBe(403);
  });
});
