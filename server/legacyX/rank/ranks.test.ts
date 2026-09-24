import { describe, expect, it } from "vitest";
import { PRO_LEAGUE_KEEP_EXP, PRO_LEAGUE_UNLOCK_EXP, RANKS, STARTING_EXP, nextRankAfter, proLeagueUnlocked, rankForExp, rankProgress } from "./ranks";

const SPEC: Array<[number, string, number]> = [
  [1, "Recruit I", 0], [2, "Recruit II", 600], [3, "Recruit III", 700], [4, "Recruit IV", 800],
  [5, "Recruit V", 900], [6, "Recruit VI", 950], [7, "Operator I", 1000], [8, "Operator II", 1100],
  [9, "Operator III", 1200], [10, "Operator IV", 1300], [11, "Vanguard I", 1400], [12, "Vanguard II", 1500],
  [13, "Vanguard III", 1600], [14, "Vanguard IV", 1700], [15, "Ace I", 1800], [16, "Ace II", 1950],
  [17, "Apex", 2100], [18, "Legacy", 2300],
];

describe("rank ladder", () => {
  it("matches the 18 ranks and thresholds of RANK-SYSTEM.md section 4", () => {
    expect(RANKS.map(rank => [rank.id, rank.name, rank.minimumExp])).toEqual(SPEC);
    expect(RANKS.map(rank => rank.imageKey)).toEqual(SPEC.map(([id]) => `rank-${String(id).padStart(2, "0")}`));
  });

  it.each(SPEC)("rank %i (%s) starts exactly at %i EXP", (id, _name, minimum) => {
    expect(rankForExp(minimum).id).toBe(id);
    if (minimum > 0) expect(rankForExp(minimum - 1).id).toBe(id - 1);
  });

  it("starts everyone at 1000 EXP, Operator I", () => {
    expect(STARTING_EXP).toBe(1000);
    expect(rankForExp(STARTING_EXP).name).toBe("Operator I");
  });

  it("keeps Legacy for any EXP above 2300 and never goes below Recruit I", () => {
    expect(rankForExp(99_999).name).toBe("Legacy");
    expect(rankForExp(-50).name).toBe("Recruit I");
    expect(nextRankAfter(rankForExp(2300))).toBeNull();
  });

  it("reports progress toward the next rank", () => {
    expect(rankProgress(1050)).toMatchObject({ expToNext: 50, progress: 0.5 });
    expect(rankProgress(1050).next?.name).toBe("Operator II");
    expect(rankProgress(2500)).toMatchObject({ expToNext: null, progress: 1, next: null });
  });

  it("never uses the old CS:GO rank names", () => {
    expect(RANKS.map(rank => rank.name).join(" ")).not.toMatch(/Silver|Gold Nova|Guardian|Eagle|Supreme|Global Elite/);
  });
});

describe("Pro League access", () => {
  it("unlocks at 1400 EXP (Vanguard I)", () => {
    expect(PRO_LEAGUE_UNLOCK_EXP).toBe(1400);
    expect(proLeagueUnlocked(1399, false)).toBe(false);
    expect(proLeagueUnlocked(1400, false)).toBe(true);
    expect(rankForExp(1400).name).toBe("Vanguard I");
  });

  it("is only removed below 1350", () => {
    expect(PRO_LEAGUE_KEEP_EXP).toBe(1350);
    expect(proLeagueUnlocked(1360, true)).toBe(true);
    expect(proLeagueUnlocked(1350, true)).toBe(true);
    expect(proLeagueUnlocked(1349, true)).toBe(false);
    expect(proLeagueUnlocked(1360, false)).toBe(false);
  });
});
