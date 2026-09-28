import { describe, expect, it } from "vitest";
import { sha256 } from "./auth";
import { completeLink, createLinkRequest, isLinkToken, linkCallbackUrl, linkRequestSchema, linkResultPage, listLinks, pendingLinkRequest, returnToMatches, unlink } from "./discordLinks";

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> };

/** Records every query and answers from `results[table.op]`, in the order they are asked. */
function fakeDb(results: Record<string, Array<{ data: unknown; error: unknown }>>, rpc: { data: unknown; error: unknown } = { data: null, error: null }) {
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
        delete: () => Object.assign(call, { op: "delete" }) && builder,
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => (call.filters.push(["eq", column, value]), builder),
        lt: (column: string, value: unknown) => (call.filters.push(["lt", column, value]), builder),
        in: (column: string, value: unknown) => (call.filters.push(["in", column, value]), builder),
        maybeSingle: async () => answer(),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { db: db as any, calls, rpcCalls };
}

const now = new Date("2026-09-28T12:00:00.000Z");

describe("Discord links", () => {
  it("validates the bot's link request", () => {
    expect(linkRequestSchema.safeParse({ discordId: "123456789012345678", discordName: "player" }).success).toBe(true);
    expect(linkRequestSchema.safeParse({ discordId: "12345", discordName: "player" }).success).toBe(false);
    expect(linkRequestSchema.safeParse({ discordId: "123456789012345678", discordName: "" }).success).toBe(false);
  });

  it("stores only the token hash and returns a 10-minute token", async () => {
    const { db, calls } = fakeDb({});
    const { token, expiresAt } = await createLinkRequest(db, { discordId: "123456789012345678", discordName: "player" }, now);
    expect(isLinkToken(token)).toBe(true);
    expect(expiresAt).toBe("2026-09-28T12:10:00.000Z");
    expect(calls[0]).toMatchObject({ table: "discord_link_requests", op: "delete", filters: [["lt", "expires_at", now.toISOString()]] });
    expect(calls[1]).toMatchObject({ table: "discord_link_requests", op: "insert", payload: { token_hash: sha256(token), discord_id: "123456789012345678", discord_name: "player", expires_at: expiresAt } });
    expect(JSON.stringify(calls)).not.toContain(token);
  });

  it("treats used or expired requests as gone", async () => {
    const row = { discord_id: "123456789012345678", discord_name: "player", expires_at: "2026-09-28T12:05:00.000Z", used_at: null };
    const { db } = fakeDb({ "discord_link_requests.select": [{ data: row, error: null }, { data: { ...row, used_at: "2026-09-28T11:59:00Z" }, error: null }, { data: { ...row, expires_at: "2026-09-28T11:00:00Z" }, error: null }, { data: null, error: null }] });
    expect(await pendingLinkRequest(db, "t".repeat(32), now)).toEqual({ discordId: "123456789012345678", discordName: "player" });
    expect(await pendingLinkRequest(db, "t".repeat(32), now)).toBeNull();
    expect(await pendingLinkRequest(db, "t".repeat(32), now)).toBeNull();
    expect(await pendingLinkRequest(db, "t".repeat(32), now)).toBeNull();
  });

  it("completes the link atomically in the database", async () => {
    const { db, rpcCalls } = fakeDb({}, { data: "123456789012345678", error: null });
    expect(await completeLink(db, "t".repeat(32), "user-1")).toBe("123456789012345678");
    expect(rpcCalls).toEqual([["complete_discord_link", { p_token_hash: sha256("t".repeat(32)), p_user_id: "user-1" }]]);
    expect(await completeLink(fakeDb({}, { data: null, error: null }).db, "t".repeat(32), "user-1")).toBeNull();
  });

  it("accepts only a Steam response issued for this exact link callback", () => {
    const expected = linkCallbackUrl("https://api.legacyx.cc", "t".repeat(32));
    expect(expected).toBe(`https://api.legacyx.cc/api/v1/discord/link/${"t".repeat(32)}/callback`);
    expect(returnToMatches({ "openid.return_to": expected }, expected)).toBe(true);
    expect(returnToMatches({ "openid.return_to": "https://api.legacyx.cc/api/v1/auth/steam/callback" }, expected)).toBe(false);
    expect(returnToMatches({}, expected)).toBe(false);
    expect(isLinkToken("../../etc")).toBe(false);
  });

  it("lists links with the player's rank; unranked players have no rank", async () => {
    const { db } = fakeDb({
      "discord_links.select": [{ data: [
        { user_id: "u1", discord_id: "111111111111111111", discord_name: "a", linked_at: "t1", users: { steam_id: "76561198000000001", username: "Alpha" } },
        { user_id: "u2", discord_id: "222222222222222222", discord_name: "b", linked_at: "t2", users: [{ steam_id: "76561198000000002", username: "Bravo" }] },
      ], error: null }],
      "competitive_player_profiles.select": [{ data: [{ user_id: "u1", rank_id: 12, rank_name: "Vanguard II", current_exp: 2400, matches_completed: 30 }], error: null }],
    });
    expect(await listLinks(db)).toEqual([
      { discordId: "111111111111111111", discordName: "a", linkedAt: "t1", steamId: "76561198000000001", username: "Alpha", rankId: 12, rankName: "Vanguard II", currentExp: 2400, matchesCompleted: 30 },
      { discordId: "222222222222222222", discordName: "b", linkedAt: "t2", steamId: "76561198000000002", username: "Bravo", rankId: null, rankName: null, currentExp: 0, matchesCompleted: 0 },
    ]);
  });

  it("reports whether an unlink removed anything", async () => {
    const { db, calls } = fakeDb({ "discord_links.delete": [{ data: [{ user_id: "u1" }], error: null }, { data: [], error: null }] });
    expect(await unlink(db, "111111111111111111")).toBe(true);
    expect(await unlink(db, "111111111111111111")).toBe(false);
    expect(calls[0]!.filters).toEqual([["eq", "discord_id", "111111111111111111"]]);
  });

  it("escapes the result page and pins its style with a CSP hash", () => {
    const page = linkResultPage(true, "Done", "<script>alert(1)</script>");
    expect(page.html).not.toContain("<script>");
    expect(page.html).toContain("&lt;script&gt;");
    expect(page.csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'/);
  });
});
