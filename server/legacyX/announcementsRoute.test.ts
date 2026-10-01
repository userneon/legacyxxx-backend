import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Query = { table: string; op: "select" | "insert"; payload?: Record<string, unknown>; filters: Array<[string, string, unknown]> };
const runs: Query[] = [];
let listedRows: Array<Record<string, unknown>> = [];
let newestRows: Array<{ id: number }> = [];

vi.mock("./supabase", async (importActual) => {
  const actual = await importActual<typeof import("./supabase")>();
  const result = (query: Query) => {
    runs.push(query);
    if (query.table === "audit_logs") return { data: null, error: null };
    if (query.op === "insert") return { data: { id: 5 }, error: null };
    if (query.filters.some(([op]) => op === "gt")) return { data: listedRows, error: null };
    return { data: newestRows, error: null };
  };
  const from = (table: string) => {
    const query: Query = { table, op: "select", filters: [] };
    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (payload: Record<string, unknown>) => { query.op = "insert"; query.payload = payload; return builder; },
      gt: (column: string, value: unknown) => { query.filters.push(["gt", column, value]); return builder; },
      gte: (column: string, value: unknown) => { query.filters.push(["gte", column, value]); return builder; },
      order: () => builder,
      limit: () => builder,
      single: () => builder,
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result(query)).then(resolve, reject),
    };
    return builder;
  };
  return { ...actual, legacyXDb: () => ({ from }) };
});

const SCOPES: Record<string, string[]> = { deploy: ["announce:write"], bot: ["discord:link"], other: ["stats:write"] };
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
  listedRows = [];
  newestRows = [];
});

const note = { title: "Game servers updated", lines: ["CS2 build 1 → 2"], footer: "Restarted: 27015", banner: "cs2-update-finished" };
const post = (token: string | null, body: unknown) => fetch(`${baseUrl}/plugin/announcements`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const get = (token: string | null, query = "") => fetch(`${baseUrl}/plugin/announcements${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const inserts = () => runs.filter((run) => run.op === "insert" && run.table === "announcements");

describe("update announcements", () => {
  it("records an announcement for a token with the announce:write scope", async () => {
    const response = await post("deploy", note);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ recorded: true, id: 5 });
    expect(inserts()[0].payload).toEqual({ title: "Game servers updated", lines: ["CS2 build 1 → 2"], footer: "Restarted: 27015", banner: "cs2-update-finished" });
  });

  it("refuses other tokens, no token and unknown banners", async () => {
    expect((await post(null, note)).status).toBe(401);
    expect((await post("bot", note)).status).toBe(403);
    expect((await post("other", note)).status).toBe(403);
    expect((await post("deploy", { ...note, banner: "something-else" })).status).toBe(400);
    expect((await post("deploy", { title: "x", lines: [] })).status).toBe(400);
    expect(inserts()).toHaveLength(0);
  });

  it("tells the bot where the feed stands, then lists what came after an id, oldest first", async () => {
    newestRows = [{ id: 7 }];
    const first = await get("bot");
    expect(await first.json()).toEqual({ announcements: [], latestId: 7 });
    listedRows = [{ id: 6, title: "Website updated", lines: ["Faster pages"], footer: null, banner: null, created_at: "2026-10-01T10:00:00Z" }];
    const next = await get("bot", "?after=5");
    expect(await next.json()).toEqual({ announcements: [{ id: 6, title: "Website updated", lines: ["Faster pages"], footer: null, banner: null, createdAt: "2026-10-01T10:00:00Z" }], latestId: 7 });
  });

  it("does not let the deploy token read the feed", async () => {
    expect((await get("deploy")).status).toBe(403);
  });
});
