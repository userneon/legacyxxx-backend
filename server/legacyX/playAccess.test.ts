import { describe, expect, it } from "vitest";
import { cooldownMinutesFor, leaveStatus, loadLeaves, loadLoggedIn, playerAccess } from "./playAccess";

const now = new Date("2026-10-18T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

describe("leave cooldown", () => {
  it("the 1st and 2nd leave in 24 hours only cost EXP; the 3rd blocks 30 minutes, then 30 more each time", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(cooldownMinutesFor)).toEqual([0, 0, 0, 30, 60, 90, 120]);
    expect(leaveStatus([], now)).toMatchObject({ leavesToday: 0, cooldown: null, next: { cooldownMinutes: 0 } });
    expect(leaveStatus([ago(100)], now)).toMatchObject({ leavesToday: 1, cooldown: null, next: { cooldownMinutes: 0 } });
    // the 2nd leave: the next one is the one that blocks
    expect(leaveStatus([ago(300), ago(100)], now).next.cooldownMinutes).toBe(30);
  });

  it("blocks from the latest leave for 30 minutes at the 3rd, 60 at the 4th", () => {
    const third = leaveStatus([ago(600), ago(300), ago(10)], now);
    expect(third.cooldown).toEqual({ until: new Date(now.getTime() + 20 * 60_000).toISOString(), minutes: 30 });
    expect(leaveStatus([ago(600), ago(300), ago(100)], now).cooldown).toBeNull();   // the 30 minutes are over
    const fourth = leaveStatus([ago(900), ago(600), ago(300), ago(10)], now);
    expect(fourth.cooldown).toEqual({ until: new Date(now.getTime() + 50 * 60_000).toISOString(), minutes: 60 });
    expect(fourth.next.cooldownMinutes).toBe(90);
  });

  it("forgets leaves older than 24 hours", () => {
    const old = leaveStatus([ago(25 * 60), ago(24 * 60 + 1), ago(20 * 60), ago(5)], now);
    expect(old.leavesToday).toBe(2);
    expect(old.cooldown).toBeNull();
  });
});

function fakeDb(tables: Record<string, any[]>) {
  const calls: Array<[string, string]> = [];
  const from = (table: string) => {
    let rows = tables[table] ?? [];
    const query: any = {
      select: () => query,
      in: (column: string, values: string[]) => ((rows = rows.filter((row) => values.includes(row[column]))), query),
      gte: () => query,
      gt: () => query,
      is: (column: string) => ((rows = rows.filter((row) => row[column] == null)), calls.push([table, column]), query),
      limit: async () => ({ data: rows, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
    };
    return query;
  };
  return { from, calls } as any;
}

describe("reading leaves and logins", () => {
  it("counts only the leaver rows", async () => {
    const db = fakeDb({
      competitive_match_exp: [
        { user_id: "u1", exp_breakdown: { rule: "leaver" }, created_at: ago(5) },
        { user_id: "u1", exp_breakdown: { rule: "invalid_match" }, created_at: ago(6) },
        { user_id: "u1", exp_breakdown: null, created_at: ago(7) },
        { user_id: "u2", exp_breakdown: { rule: "leaver" }, created_at: ago(8) },
      ],
    });
    const leaves = await loadLeaves(db, ["u1", "u2"], now);
    expect(leaves.get("u1")).toHaveLength(1);
    expect(leaves.get("u2")).toHaveLength(1);
    expect((await loadLeaves(db, [], now)).size).toBe(0);
  });

  it("a Steam ID with no account, or no live session, is not logged in", async () => {
    const db = fakeDb({
      users: [{ id: "u1", steam_id: "76561198000000001" }, { id: "u2", steam_id: "76561198000000002" }],
      user_sessions: [{ user_id: "u1", revoked_at: null }, { user_id: "u2", revoked_at: "x" }],
      competitive_match_exp: [3, 2, 1].map((minutes) => ({ user_id: "u1", exp_breakdown: { rule: "leaver" }, created_at: ago(minutes) })),
    });
    expect([...(await loadLoggedIn(db, ["u1", "u2"], now))]).toEqual(["u1"]);
    const access = await playerAccess(db, ["76561198000000001", "76561198000000002", "76561198000000003"], now);
    expect(access.map((a) => [a.steamId.slice(-1), a.loggedIn])).toEqual([["1", true], ["2", false], ["3", false]]);
    expect(access[0]!.cooldown?.minutes).toBe(30);
    expect(access[1]!.cooldown).toBeNull();
  });
});
