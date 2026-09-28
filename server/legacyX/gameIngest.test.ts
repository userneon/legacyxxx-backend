import { describe, expect, it } from "vitest";
import { issueBan, issueBanSchema, revokeAllBans } from "./bans";
import { issueCommPenalty, issueCommPenaltySchema, liftCommPenalties } from "./gamePenalties";
import { heartbeatSchema, ingestHeartbeat } from "./serverHeartbeat";

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> };

function fakeDb(results: Record<string, Array<{ data: unknown; error: unknown }>> = {}, rpcResult: { data: unknown; error: unknown } = { data: "user-1", error: null }) {
  const calls: Call[] = [];
  const rpcCalls: Array<[string, any]> = [];
  const db = {
    rpc: async (name: string, args: unknown) => (rpcCalls.push([name, args]), rpcResult),
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const answer = () => (calls.push(call), results[`${table}.${call.op}`]?.shift() ?? { data: null, error: null });
      const builder: any = {
        insert: (payload: unknown) => Object.assign(call, { op: "insert", payload }) && builder,
        update: (payload: unknown) => Object.assign(call, { op: "update", payload }) && builder,
        delete: () => Object.assign(call, { op: "delete" }) && builder,
        select: () => builder,
        eq: (c: string, v: unknown) => (call.filters.push(["eq", c, v]), builder),
        is: (c: string, v: unknown) => (call.filters.push(["is", c, v]), builder),
        single: async () => answer(),
        maybeSingle: async () => answer(),
        then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { db: db as any, calls, rpcCalls };
}

const now = new Date("2026-09-28T12:00:00.000Z");
const STEAM = "76561198000000001";

describe("game → API → database", () => {
  it("records a server heartbeat with its human players in one database call", async () => {
    const input = heartbeatSchema.parse({ serverId: "srv-1", name: "LEGACY-X #1", address: "1.2.3.4:27015", map: "de_mirage", mode: "competitive_5v5", maxPlayers: 10, players: [{ steamId: STEAM, name: "alice" }] });
    const { db, rpcCalls } = fakeDb({}, { data: 1, error: null });
    expect(await ingestHeartbeat(db, input)).toEqual({ players: 1 });
    expect(rpcCalls).toEqual([["ingest_server_heartbeat", {
      p_server: { server_id: "srv-1", name: "LEGACY-X #1", address: "1.2.3.4:27015", gotv_address: "", map: "de_mirage", mode: "competitive_5v5", max_players: 10 },
      p_players: [{ steam_id: STEAM, name: "alice" }],
    }]]);
    expect(heartbeatSchema.safeParse({ serverId: "bad id!", maxPlayers: 10 }).success).toBe(false);
    expect(heartbeatSchema.safeParse({ serverId: "srv-1", maxPlayers: 10, players: [{ steamId: "BOT", name: "x" }] }).success).toBe(false);
  });

  it("marks bans issued on a CS2 server as game bans with the admin's SteamID", async () => {
    const input = issueBanSchema.parse({ steamId: STEAM, durationMinutes: 60, reason: "wallhack", issuerName: "admin (in-game)", source: "game", issuerSteamId: "76561198000000009" });
    const { db, calls } = fakeDb({ "penalties.insert": [{ data: { id: "p1" }, error: null }], "bans.insert": [{ data: { id: "b1" }, error: null }] });
    await issueBan(db, input, now);
    expect(calls[1]).toMatchObject({ table: "bans", payload: { source: "game", issuer_steam_id: "76561198000000009" } });
    expect(issueBanSchema.parse({ steamId: STEAM, durationMinutes: 0, reason: "x", issuerName: "y" }).source).toBe("panel");
  });

  it("!cleanbans wipes every ban only for a website owner", async () => {
    const owner = fakeDb({
      "users.select": [{ data: { id: "u-owner" }, error: null }],
      "staff.select": [{ data: { role: "OWNER" }, error: null }],
      "bans.update": [{ data: [{ id: "b1" }, { id: "b2" }], error: null }],
      "penalties.update": [{ data: [{ id: "p1" }], error: null }],
    });
    expect(await revokeAllBans(owner.db, { issuerSteamId: STEAM, issuerName: "owner (in-game)" }, now)).toEqual({ bansLifted: 2, penaltiesLifted: 1 });
    expect(owner.calls[1]!.filters).toEqual([["eq", "user_id", "u-owner"], ["eq", "status", "active"]]);
    expect(owner.calls[2]).toMatchObject({ table: "bans", op: "update", filters: [["is", "revoked_at", null]] });

    const manager = fakeDb({ "users.select": [{ data: { id: "u2" }, error: null }], "staff.select": [{ data: { role: "MANAGER" }, error: null }] });
    await expect(revokeAllBans(manager.db, { issuerSteamId: STEAM, issuerName: "m" }, now)).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.calls.some((c) => c.table === "bans")).toBe(false);
    const stranger = fakeDb({ "users.select": [{ data: null, error: null }] });
    await expect(revokeAllBans(stranger.db, { issuerSteamId: STEAM, issuerName: "x" }, now)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("records in-game mutes and gags as public penalties and lifts them", async () => {
    const input = issueCommPenaltySchema.parse({ steamId: STEAM, type: "gag", durationMinutes: 30, reason: "spam", issuerName: "admin (in-game)" });
    const { db, calls, rpcCalls } = fakeDb({ "penalties.insert": [{ data: { id: "p9" }, error: null }] });
    expect(await issueCommPenalty(db, input, now)).toEqual({ penaltyId: "p9", isPermanent: false, expiresAt: "2026-09-28T12:30:00.000Z" });
    expect(rpcCalls[0]![0]).toBe("ensure_steam_user");
    expect(calls[0]).toMatchObject({ table: "penalties", op: "insert", payload: { user_id: "user-1", type: "gag", term: "30 minutes", is_permanent: false, admin_name: "admin (in-game)" } });
    expect(issueCommPenaltySchema.safeParse({ ...input, type: "ban" }).success).toBe(false);

    const lift = fakeDb({ "users.select": [{ data: { id: "user-1" }, error: null }], "penalties.update": [{ data: [{ id: "p9" }], error: null }] });
    expect(await liftCommPenalties(lift.db, { steamId: STEAM, type: "gag", issuerName: "admin" })).toEqual({ lifted: 1 });
    expect(lift.calls[1]!.filters).toEqual([["eq", "user_id", "user-1"], ["eq", "type", "gag"], ["eq", "is_unbanned", false]]);
  });
});
