import { describe, expect, it } from "vitest";
import { authorizationRequestSchema, resolveAuthorizations } from "./adminAuthorization";

const now = new Date("2026-09-27T12:00:00.000Z");

function fakeDb(rows: unknown, error: unknown = null) {
  const calls: Array<[string, unknown]> = [];
  const db = {
    rpc: async (name: string, args: unknown) => {
      calls.push([name, args]);
      return { data: rows, error };
    },
  };
  return { db: db as any, calls };
}

const row = (steamId: string, role: string, status: string, source: string, expiresAt: string | null = null) => ({ steam_id: steamId, role, status, source, expires_at: expiresAt });

describe("in-game staff authorization", () => {
  it("validates the request: server id format, SteamID64 only, 1-64 players", () => {
    expect(authorizationRequestSchema.safeParse({ serverId: "eu-5v5-1", steamIds: ["76561198000000001"] }).success).toBe(true);
    expect(authorizationRequestSchema.safeParse({ serverId: "", steamIds: ["76561198000000001"] }).success).toBe(false);
    expect(authorizationRequestSchema.safeParse({ serverId: "a b", steamIds: ["76561198000000001"] }).success).toBe(false);
    expect(authorizationRequestSchema.safeParse({ serverId: "x", steamIds: [] }).success).toBe(false);
    expect(authorizationRequestSchema.safeParse({ serverId: "x", steamIds: ["STEAM_0:1:1"] }).success).toBe(false);
    expect(authorizationRequestSchema.safeParse({ serverId: "x", steamIds: Array(65).fill("76561198000000001") }).success).toBe(false);
    expect(authorizationRequestSchema.safeParse({ serverId: "x", steamIds: ["76561198000000001"], role: "owner" }).success).toBe(false);
  });

  it("adds the clan tag of an authorized staff member, and leaves it out when the clan lookup fails", async () => {
    const answers: Record<string, { data: unknown; error: unknown }> = {
      users: { data: [{ id: "u-1", steam_id: "76561198000000001" }], error: null },
      clan_members: { data: [{ user_id: "u-1", clans: { tag: "WOLF" } }], error: null },
    };
    const db = {
      rpc: async () => ({ data: [row("76561198000000001", "owner", "active", "global"), row("76561198000000002", "admin", "active", "server")], error: null }),
      from: (table: string) => ({ select: () => ({ in: async () => answers[table] }) }),
    };
    const result = await resolveAuthorizations(db as any, { serverId: "srv-1", steamIds: ["76561198000000001", "76561198000000002"] }, now);
    expect(result.map((entry) => entry.clanTag)).toEqual(["WOLF", null]);

    const broken = { rpc: db.rpc, from: () => { throw new Error("down"); } };
    const fallback = await resolveAuthorizations(broken as any, { serverId: "srv-1", steamIds: ["76561198000000001"] }, now);
    expect(fallback[0]).toMatchObject({ authorized: true, role: "owner", clanTag: null });
  });

  it("asks the database once for the distinct SteamIDs of the server", async () => {
    const { db, calls } = fakeDb([]);
    await resolveAuthorizations(db, { serverId: "srv-1", steamIds: ["76561198000000001", "76561198000000001", "76561198000000002"] }, now);
    expect(calls).toEqual([["resolve_game_staff", { p_server_id: "srv-1", p_steam_ids: ["76561198000000001", "76561198000000002"] }]]);
  });

  it("authorizes each staff role only while active", async () => {
    const { db } = fakeDb([
      row("76561198000000001", "owner", "active", "global"),
      row("76561198000000002", "manager", "active", "global"),
      row("76561198000000003", "admin", "active", "server"),
      row("76561198000000004", "staff", "active", "server", "2026-09-28T00:00:00.000Z"),
    ]);
    const result = await resolveAuthorizations(db, { serverId: "srv-1", steamIds: ["76561198000000001", "76561198000000002", "76561198000000003", "76561198000000004"] }, now);
    expect(result).toEqual([
      { steamId: "76561198000000001", authorized: true, role: "owner", status: "active", source: "global", expiresAt: null, clanTag: null },
      { steamId: "76561198000000002", authorized: true, role: "manager", status: "active", source: "global", expiresAt: null, clanTag: null },
      { steamId: "76561198000000003", authorized: true, role: "admin", status: "active", source: "server", expiresAt: null, clanTag: null },
      { steamId: "76561198000000004", authorized: true, role: "staff", status: "active", source: "server", expiresAt: "2026-09-28T00:00:00.000Z", clanTag: null },
    ]);
  });

  it("denies players, inactive, expired, unknown roles and SteamIDs the database did not answer for", async () => {
    const { db } = fakeDb([
      row("76561198000000001", "player", "none", "none"),
      row("76561198000000002", "player", "suspended", "global"),
      row("76561198000000003", "player", "revoked", "server"),
      // Expired between the query and now: still refused.
      row("76561198000000004", "admin", "active", "server", "2026-09-27T11:59:59.000Z"),
      row("76561198000000005", "root", "active", "server"),
      // Not asked for: ignored.
      row("76561198000000099", "owner", "active", "global"),
    ]);
    const ids = ["76561198000000001", "76561198000000002", "76561198000000003", "76561198000000004", "76561198000000005", "76561198000000006"];
    const result = await resolveAuthorizations(db, { serverId: "srv-1", steamIds: ids }, now);
    expect(result.map((r) => [r.steamId, r.authorized, r.role, r.status])).toEqual([
      ["76561198000000001", false, "player", "none"],
      ["76561198000000002", false, "player", "suspended"],
      ["76561198000000003", false, "player", "revoked"],
      ["76561198000000004", false, "player", "expired"],
      ["76561198000000005", false, "player", "active"],
      ["76561198000000006", false, "player", "none"],
    ]);
  });

  it("ignores malformed rows instead of trusting them", async () => {
    const { db } = fakeDb([{ steam_id: "76561198000000001", role: "owner" }, "garbage", null]);
    const [result] = await resolveAuthorizations(db, { serverId: "srv-1", steamIds: ["76561198000000001"] }, now);
    expect(result).toMatchObject({ authorized: false, role: "player" });
  });

  it("fails the request when the database errors", async () => {
    const { db } = fakeDb(null, { code: "XX000", message: "boom" });
    await expect(resolveAuthorizations(db, { serverId: "srv-1", steamIds: ["76561198000000001"] }, now)).rejects.toThrow();
  });
});
