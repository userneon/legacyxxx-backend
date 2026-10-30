import { describe, expect, it } from "vitest";
import { clanAchievements, clanStats, levelFor, matchXp } from "./clanProgress";

describe("clan level", () => {
  it("starts at level 1 and climbs at each floor", () => {
    expect(levelFor(0)).toMatchObject({ level: 1, floor: 0, next: 250 });
    expect(levelFor(249).level).toBe(1);
    expect(levelFor(250)).toMatchObject({ level: 2, floor: 250, next: 600 });
    expect(levelFor(1_000_000)).toMatchObject({ level: 15, next: null });
    expect(levelFor(-5).xp).toBe(0);
  });
  it("gives XP by outcome and nothing to a leaver", () => {
    expect(matchXp("win", false)).toBe(25);
    expect(matchXp("draw", false)).toBe(15);
    expect(matchXp("loss", false)).toBe(10);
    expect(matchXp("win", true)).toBe(0);
  });
});

describe("clan stats", () => {
  const row = (user: string, match: string, outcome: string, stats: Record<string, unknown>, created = new Date().toISOString()) => ({ user_id: user, match_id: match, outcome, exp_delta: 20, created_at: created, leaver: false, stats });
  it("counts a match once for the clan and sums every member's numbers", () => {
    const result = clanStats([
      row("a", "m1", "win", { kills: 20, deaths: 10, headshot_kills: 10, "5k": 1, "1v2": 1 }),
      row("b", "m1", "win", { kills: 10, deaths: 10 }),
      row("a", "m2", "loss", { kills: 5, deaths: 15 }),
    ]);
    expect(result.totals).toMatchObject({ matches: 2, wins: 1, losses: 1, kills: 35, deaths: 35, aces: 1, clutches: 1, kd: 1, winRate: 50 });
    expect(result.leaders.kills?.userId).toBe("a");
    expect(result.leaders.kd).toBeNull(); // nobody has 5 matches yet
  });
});

describe("achievements", () => {
  it("reports the tier reached and the next goal", () => {
    const list = clanAchievements({ wins: 60, matches: 0, aces: 0, clutches: 0, level: 15, members: 3 });
    expect(list.find((entry) => entry.id === "wins")).toMatchObject({ tier: 2, goal: 100, value: 60, complete: false });
    expect(list.find((entry) => entry.id === "level")).toMatchObject({ tier: 3, complete: true });
  });
});
