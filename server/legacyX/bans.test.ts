import { describe, expect, it } from "vitest";
import { activeBans, bannedPlayer, banTerm, checkBansSchema, issueBan, issueBanSchema, revokeBans } from "./bans";

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> };

/** Records every query and answers from `results[table.op]`, in the order they are asked. */
function fakeDb(results: Record<string, Array<{ data: unknown; error: unknown }>>, rpc: { data: unknown; error: unknown } = { data: "user-1", error: null }) {
  const calls: Call[] = [];
  const rpcCalls: Array<[string, unknown]> = [];
  const db = {
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push([name, args]);
      return rpc;
    },
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const answer = () => {
        calls.push(call);
        return results[`${table}.${call.op}`]?.shift() ?? { data: null, error: null };
      };
      const builder: any = {
        insert: (payload: unknown) => Object.assign(call, { op: "insert", payload }) && builder,
        update: (payload: unknown) => Object.assign(call, { op: "update", payload }) && builder,
        delete: () => Object.assign(call, { op: "delete" }) && builder,
        select: () => builder,
        eq: (column: string, value: unknown) => (call.filters.push(["eq", column, value]), builder),
        is: (column: string, value: unknown) => (call.filters.push(["is", column, value]), builder),
        in: (column: string, value: unknown) => (call.filters.push(["in", column, value]), builder),
        single: async () => answer(),
        maybeSingle: async () => answer(),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { db: db as any, calls, rpcCalls };
}

const now = new Date("2026-09-27T12:00:00.000Z");

describe("central bans", () => {
  it("validates input: SteamID64 only, bounded duration and text", () => {
    expect(issueBanSchema.safeParse({ steamId: "76561198000000001", durationMinutes: 1440, reason: "wallhack", issuerName: "staff (Discord)" }).success).toBe(true);
    expect(issueBanSchema.safeParse({ steamId: "STEAM_0:1:1", durationMinutes: 0, reason: "x", issuerName: "s" }).success).toBe(false);
    expect(issueBanSchema.safeParse({ steamId: "76561198000000001", durationMinutes: -1, reason: "x", issuerName: "s" }).success).toBe(false);
    expect(issueBanSchema.safeParse({ steamId: "76561198000000001", durationMinutes: 0, reason: "", issuerName: "s" }).success).toBe(false);
    expect(checkBansSchema.safeParse({ steamIds: [] }).success).toBe(false);
  });

  it("names the term like people write it", () => {
    expect([0, 60, 180, 1440, 10080, 43200, 45].map(banTerm)).toEqual(["Permanent", "1 hour", "3 hours", "1 day", "7 days", "30 days", "45 minutes"]);
  });

  it("records a timed ban as a public penalty plus the linked admin-system ban", async () => {
    const { db, calls, rpcCalls } = fakeDb({ "penalties.insert": [{ data: { id: "pen-1" }, error: null }], "bans.insert": [{ data: { id: "ban-1" }, error: null }] });
    const result = await issueBan(db, { steamId: "76561198000000001", durationMinutes: 1440, reason: "wallhack", issuerName: "staffer (Discord)" }, now);

    expect(rpcCalls).toEqual([["ensure_steam_user", { p_steam_id: "76561198000000001", p_username: "Steam 76561198000000001", p_avatar: "" }]]);
    const writes = calls.filter((call) => call.table !== "staff");
    expect(writes[0]).toMatchObject({ table: "penalties", op: "insert", payload: { user_id: "user-1", type: "ban", reason: "wallhack", term: "1 day", is_permanent: false, expires_at: "2026-09-28T12:00:00.000Z", admin_name: "staffer (Discord)" } });
    expect(writes[1]).toMatchObject({ table: "bans", op: "insert", payload: { steam_id: "76561198000000001", user_id: "user-1", is_permanent: false, expires_at: "2026-09-28T12:00:00.000Z", source: "panel", review_status: "none", penalty_id: "pen-1", issuer_immunity: 20 } });
    expect(result).toMatchObject({ banId: "ban-1", penaltyId: "pen-1", isPermanent: false, term: "1 day" });
  });

  it("sends permanent bans to the review queue", async () => {
    const { db, calls } = fakeDb({ "penalties.insert": [{ data: { id: "pen-1" }, error: null }], "bans.insert": [{ data: { id: "ban-1" }, error: null }] });
    await issueBan(db, { steamId: "76561198000000001", durationMinutes: 0, reason: "cheat", issuerName: "s" }, now);
    expect(calls.filter((call) => call.table !== "staff")[1].payload).toMatchObject({ is_permanent: true, expires_at: null, review_status: "pending" });
  });

  it("refuses to ban an owner, and writes nothing", async () => {
    const owner = { data: [{ role: "OWNER", users: { steam_id: "76561198000000001" } }], error: null };
    const { db, calls } = fakeDb({ "staff.select": [owner] });
    await expect(issueBan(db, { steamId: "76561198000000001", durationMinutes: 0, reason: "x", issuerName: "s" }, now)).rejects.toMatchObject({ statusCode: 403 });
    expect(calls.some((call) => call.op === "insert")).toBe(false);
  });

  it("never reports an owner as banned to the game servers", async () => {
    const { db } = fakeDb({
      "bans.select": [{ data: [{ steam_id: "76561198000000001", reason: "old", is_permanent: true, expires_at: null }, { steam_id: "76561198000000002", reason: "cheat", is_permanent: true, expires_at: null }], error: null }],
      "staff.select": [{ data: [{ role: "OWNER", users: [{ steam_id: "76561198000000001" }] }], error: null }],
    });
    const bans = await activeBans(db, ["76561198000000001", "76561198000000002"], now);
    expect(bans.map((ban) => ban.steamId)).toEqual(["76561198000000002"]);
  });

  it("removes the penalty again if the ban row can't be written", async () => {
    const { db, calls } = fakeDb({ "penalties.insert": [{ data: { id: "pen-1" }, error: null }], "bans.insert": [{ data: null, error: { code: "23514", message: "check" } }] });
    await expect(issueBan(db, { steamId: "76561198000000001", durationMinutes: 60, reason: "x", issuerName: "s" }, now)).rejects.toThrow();
    expect(calls.at(-1)).toMatchObject({ table: "penalties", op: "delete", filters: [["eq", "id", "pen-1"]] });
  });

  it("lifts every active ban and ban penalty of the SteamID", async () => {
    const { db, calls } = fakeDb({
      "bans.update": [{ data: [{ id: "ban-1" }, { id: "ban-2" }], error: null }],
      "users.select": [{ data: { id: "user-1" }, error: null }],
      "penalties.update": [{ data: [{ id: "pen-1" }], error: null }],
    });
    const result = await revokeBans(db, { steamId: "76561198000000001", issuerName: "staffer (Discord)" }, now);
    expect(result).toEqual({ bansLifted: 2, penaltiesLifted: 1 });
    expect(calls[0]).toMatchObject({ table: "bans", op: "update", payload: { revoked_at: now.toISOString(), revoke_reason: "Lifted by staffer (Discord)" }, filters: [["eq", "steam_id", "76561198000000001"], ["is", "revoked_at", null]] });
    expect(calls[2]).toMatchObject({ table: "penalties", op: "update", payload: { is_unbanned: true } });
  });

  it("returns the banned player's name and avatar for the ban card", async () => {
    const { db } = fakeDb({ "users.select": [{ data: { username: "s1mple", avatar: "https://avatars/1.jpg" }, error: null }, { data: null, error: null }] });
    expect(await bannedPlayer(db, "76561198000000001")).toEqual({ steamId: "76561198000000001", username: "s1mple", avatar: "https://avatars/1.jpg" });
    expect(await bannedPlayer(db, "76561198000000002")).toBeNull();
  });

  it("reports only bans still in force, once per SteamID", async () => {
    const { db } = fakeDb({
      "bans.select": [{
        data: [
          { steam_id: "76561198000000001", reason: "cheat", is_permanent: true, expires_at: null },
          { steam_id: "76561198000000001", reason: "old", is_permanent: false, expires_at: "2026-09-30T00:00:00.000Z" },
          { steam_id: "76561198000000002", reason: "expired", is_permanent: false, expires_at: "2026-09-01T00:00:00.000Z" },
          { steam_id: "76561198000000003", reason: "toxic", is_permanent: false, expires_at: "2026-09-28T00:00:00.000Z" },
        ],
        error: null,
      }],
    });
    const bans = await activeBans(db, ["76561198000000001", "76561198000000002", "76561198000000003"], now);
    expect(bans).toEqual([
      { steamId: "76561198000000001", reason: "cheat", isPermanent: true, expiresAt: null },
      { steamId: "76561198000000003", reason: "toxic", isPermanent: false, expiresAt: "2026-09-28T00:00:00.000Z" },
    ]);
  });
});
