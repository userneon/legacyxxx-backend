import { describe, expect, it } from "vitest";

import {
  BONUS_CAP,
  LEAVER_DELTA,
  RANKS,
  calculateMatchExp,
  composeDelta,
  expectedScore,
  impactScore,
  marginTerm,
  nextRankForExp,
  performanceTerm,
  proLeagueAccess,
  rankForExp,
  type RankedMatchInput,
  type RankedPlayerInput,
  type TeamKey,
} from "./ranking";

/** A plain player: 1000 EXP, past calibration, average line for a 22-round match. */
function player(id: number, team: TeamKey, overrides: Partial<RankedPlayerInput> = {}): RankedPlayerInput {
  return {
    userId: `u${id}`,
    steamId: `7656119800000${String(id).padStart(4, "0")}`,
    team,
    expBefore: 1000,
    rankedMatchesBefore: 20,
    roundsPlayed: 22,
    kills: 16,
    deaths: 16,
    assists: 4,
    entryKills: 2,
    bombPlants: 1,
    bombDefuses: 0,
    threeKRounds: 1,
    fourKRounds: 0,
    aces: 0,
    clutchesWon: {},
    ...overrides,
  };
}

function lobby(overrides: (id: number, team: TeamKey) => Partial<RankedPlayerInput> = () => ({})): RankedPlayerInput[] {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => {
    const team: TeamKey = id <= 5 ? "team1" : "team2";
    return player(id, team, overrides(id, team));
  });
}

function match(overrides: Partial<RankedMatchInput> = {}): RankedMatchInput {
  return {
    mode: "5v5",
    finishedNormally: true,
    roundsWon: { team1: 13, team2: 9 },
    humanPlayersAtEnd: 10,
    players: lobby(),
    ...overrides,
  };
}

const find = (result: ReturnType<typeof calculateMatchExp>, userId: string) => result.players.find((entry) => entry.userId === userId)!;

describe("rank thresholds", () => {
  it("has exactly the 18 ranks of section 4", () => {
    expect(RANKS.map((entry) => [entry.name, entry.minExp])).toEqual([
      ["Recruit I", 0], ["Recruit II", 600], ["Recruit III", 700], ["Recruit IV", 800], ["Recruit V", 900], ["Recruit VI", 950],
      ["Operator I", 1000], ["Operator II", 1100], ["Operator III", 1200], ["Operator IV", 1300],
      ["Vanguard I", 1400], ["Vanguard II", 1500], ["Vanguard III", 1600], ["Vanguard IV", 1700],
      ["Ace I", 1800], ["Ace II", 1950], ["Apex", 2100], ["Legacy", 2300],
    ]);
    expect(RANKS.map((entry) => entry.imageKey)).toEqual(RANKS.map((_, index) => `rank-${String(index + 1).padStart(2, "0")}`));
  });

  it.each(RANKS.map((entry, index) => [entry, RANKS[index + 1]] as const))("maps %s to its own threshold band", (definition, next) => {
    expect(rankForExp(definition.minExp).id).toBe(definition.id);
    if (next) expect(rankForExp(next.minExp - 1).id).toBe(definition.id);
    expect(nextRankForExp(definition.minExp)?.id ?? null).toBe(next?.id ?? null);
  });

  it("starts everyone at Operator I and never goes below Recruit I", () => {
    expect(rankForExp(1000).name).toBe("Operator I");
    expect(rankForExp(-50).name).toBe("Recruit I");
    expect(rankForExp(99_999).name).toBe("Legacy");
  });
});

describe("Pro League access", () => {
  it("unlocks at 1400", () => {
    expect(proLeagueAccess(false, 1399)).toBe(false);
    expect(proLeagueAccess(false, 1400)).toBe(true);
  });

  it("is only removed below 1350", () => {
    expect(proLeagueAccess(true, 1360)).toBe(true);
    expect(proLeagueAccess(true, 1350)).toBe(true);
    expect(proLeagueAccess(true, 1349)).toBe(false);
    expect(proLeagueAccess(false, 1360)).toBe(false);
  });
});

describe("formula terms", () => {
  it("gives ±15 for equal teams", () => {
    expect(30 * (1 - expectedScore(1200, 1200))).toBeCloseTo(15);
    expect(30 * (0 - expectedScore(1200, 1200))).toBeCloseTo(-15);
  });

  it("rewards beating a stronger team more and punishes losing to a weaker one more", () => {
    expect(expectedScore(1200, 1300)).toBeCloseTo(0.36, 2);
    expect(30 * (1 - expectedScore(1200, 1300))).toBeCloseTo(19.2, 1);
    expect(30 * (0 - expectedScore(1300, 1200))).toBeCloseTo(-19.2, 1);
  });

  it("caps the margin at ±3", () => {
    expect(marginTerm(13, 9)).toBe(1);
    expect(marginTerm(13, 0)).toBe(3);
    expect(marginTerm(0, 13)).toBe(-3);
  });

  it("floors the lobby std at 0.05 and caps performance at ±8", () => {
    expect(performanceTerm(1.1, 1.0, 0.01).z).toBeCloseTo(2);
    expect(performanceTerm(1.1, 1.0, 0.01).performance).toBe(8);
    expect(performanceTerm(0.9, 1.0, 0).performance).toBe(-8);
    expect(performanceTerm(1.05, 1.0, 0.5)).toEqual({ z: expect.closeTo(0.1), performance: 1 });
  });

  it("scores impact per round, without headshots", () => {
    expect(impactScore({ roundsPlayed: 10, kills: 10, deaths: 5, assists: 2, entryKills: 1, bombPlants: 1, bombDefuses: 1, threeKRounds: 1, fourKRounds: 1, aces: 1, clutchesWon: { 1: 1, 3: 1 } }))
      .toBeCloseTo((20 + 2 - 5 + 1 + 2 + 1 + 2 + 3 + 4) / 10);
  });

  it("reproduces the worked example of section 5", () => {
    expect(composeDelta({ result: 19.2, margin: 1, performance: 8, bonus: 1, calibration: 1 })).toBe(29);
    expect(composeDelta({ result: 19.2, margin: 1, performance: -8, bonus: 0, calibration: 1 })).toBe(12);
    expect(composeDelta({ result: -19.2, margin: -1, performance: 8, bonus: 0, calibration: 1 })).toBe(-12);
    expect(composeDelta({ result: -19.2, margin: -1, performance: -8, bonus: 0, calibration: 1 })).toBe(-28);
  });

  it("clamps to ±45, or ±90 while calibrating", () => {
    expect(composeDelta({ result: 30, margin: 3, performance: 8, bonus: 2, calibration: 1 })).toBe(43);
    expect(composeDelta({ result: 30, margin: 3, performance: 8, bonus: 2, calibration: 2 })).toBe(86);
    expect(composeDelta({ result: 40, margin: 3, performance: 8, bonus: 2, calibration: 1 })).toBe(45);
    expect(composeDelta({ result: -40, margin: -3, performance: -8, bonus: 0, calibration: 2 })).toBe(-90);
  });
});

describe("calculateMatchExp", () => {
  it("equal-rated win and loss move by result + margin only when everyone plays the same", () => {
    const result = calculateMatchExp(match());
    expect(result.valid).toBe(true);
    // Same stats for all ten → z = 0 → performance 0; everyone shares the top score → MVP bonus for all.
    expect(find(result, "u1").breakdown).toMatchObject({ result: 15, margin: 1, performance: 0, bonus: 1, calibration: 1 });
    expect(find(result, "u1").expDelta).toBe(17);
    expect(find(result, "u6").breakdown).toMatchObject({ result: -15, margin: -1, performance: 0 });
    expect(find(result, "u6").expDelta).toBe(-15);
  });

  it("draw gives no result term", () => {
    const result = calculateMatchExp(match({ roundsWon: { team1: 12, team2: 12 } }));
    expect(find(result, "u1").outcome).toBe("draw");
    expect(find(result, "u1").breakdown.result).toBe(0);
    expect(find(result, "u1").breakdown.margin).toBe(0);
  });

  it("uses the average EXP at match start for team ratings", () => {
    const players = lobby((id, team) => ({ expBefore: team === "team1" ? 1200 : 1300 }));
    const result = calculateMatchExp(match({ players }));
    expect(result.teamRating).toEqual({ team1: 1200, team2: 1300 });
    expect(find(result, "u1").breakdown.result).toBeCloseTo(19.2, 1);
    expect(find(result, "u6").breakdown.result).toBeCloseTo(-19.2, 1);
  });

  it("measures performance against this lobby's mean and std", () => {
    const players = lobby((id) => (id === 1 ? { kills: 30, deaths: 8 } : id === 6 ? { kills: 6, deaths: 20 } : {}));
    const result = calculateMatchExp(match({ players }));
    expect(find(result, "u1").breakdown.performance).toBe(8);
    expect(find(result, "u1").breakdown.mvp).toBe(true);
    expect(find(result, "u6").breakdown.performance).toBe(-8);
    expect(find(result, "u2").breakdown.performance).toBeLessThanOrEqual(0);
  });

  it("caps the bonus at +2 (ace or 1v3+ clutch, plus MVP)", () => {
    const players = lobby((id) => (id === 1 ? { kills: 30, aces: 1, clutchesWon: { 4: 1 } } : id === 2 ? { clutchesWon: { 2: 1 } } : {}));
    const result = calculateMatchExp(match({ players }));
    expect(find(result, "u1").breakdown.bonus).toBe(BONUS_CAP);
    // 1v2 is not a big clutch, and u2 isn't the MVP.
    expect(find(result, "u2").breakdown.bonus).toBe(0);
  });

  it("doubles the change during the first 10 ranked matches", () => {
    const players = lobby((id) => ({ rankedMatchesBefore: id === 1 || id === 6 ? 9 : 10 }));
    const result = calculateMatchExp(match({ players }));
    expect(find(result, "u1").breakdown.calibration).toBe(2);
    expect(find(result, "u1").expDelta).toBe(34);
    expect(find(result, "u2").breakdown.calibration).toBe(1);
    expect(find(result, "u2").expDelta).toBe(17);
    expect(find(result, "u6").expDelta).toBe(-30);
  });

  it("gives a leaver exactly −25 as a loss, without performance", () => {
    const players = lobby((id) => (id === 3 ? { leftEarly: true, roundsPlayed: 6, kills: 25 } : {}));
    const result = calculateMatchExp(match({ players, humanPlayersAtEnd: 9 }));
    const leaver = find(result, "u3");
    expect(leaver.expDelta).toBe(LEAVER_DELTA);
    expect(leaver.outcome).toBe("loss");
    expect(leaver.breakdown).toMatchObject({ rule: "leaver", performance: 0, result: 0 });
    expect(leaver.countsAsRankedMatch).toBe(true);
  });

  it("halves only a loss for a team that played ≥3 rounds short-handed", () => {
    const players = lobby((id) => (id === 8 ? { leftEarly: true, roundsPlayed: 5 } : {}));
    const lost = calculateMatchExp(match({ players, humanPlayersAtEnd: 9, shortHandedRounds: { team2: 17 } }));
    expect(find(lost, "u6").breakdown.result).toBeCloseTo(-7.5);
    expect(find(lost, "u6").breakdown.shortHanded).toBe(true);

    const won = calculateMatchExp(match({ players, humanPlayersAtEnd: 9, roundsWon: { team1: 9, team2: 13 }, shortHandedRounds: { team2: 17 } }));
    expect(find(won, "u6").breakdown.result).toBeCloseTo(15);

    const brief = calculateMatchExp(match({ players, humanPlayersAtEnd: 9, shortHandedRounds: { team2: 2 } }));
    expect(find(brief, "u6").breakdown.result).toBeCloseTo(-15);
  });

  it("saves an invalid match with 0 EXP for everyone except a leaver", () => {
    const players = lobby((id) => (id === 2 ? { leftEarly: true, roundsPlayed: 4 } : {}));
    for (const invalid of [
      { finishedNormally: false },
      { humanPlayersAtEnd: 7 },
      { roundsWon: { team1: 7, team2: 5 } },
    ] satisfies Partial<RankedMatchInput>[]) {
      const result = calculateMatchExp(match({ players, ...invalid }));
      expect(result.valid).toBe(false);
      expect(result.invalidReasons.length).toBeGreaterThan(0);
      expect(find(result, "u1")).toMatchObject({ expDelta: 0, countsAsRankedMatch: false });
      expect(find(result, "u1").breakdown.rule).toBe("invalid_match");
      expect(find(result, "u2").expDelta).toBe(LEAVER_DELTA);
    }
  });

  it("accepts 8 human players at the end (not strictly 10) and counts fills for their rounds", () => {
    const players = [
      ...lobby(),
      player(11, "team2", { roundsPlayed: 14, expBefore: 900 }),
    ];
    const result = calculateMatchExp(match({ players, humanPlayersAtEnd: 8 }));
    expect(result.valid).toBe(true);
    const fill = find(result, "u11");
    expect(fill.countsAsRankedMatch).toBe(true);
    expect(fill.expDelta).not.toBe(0);
  });

  it("gives 0 to a player present for under 50% of rounds", () => {
    const players = lobby((id) => (id === 4 ? { roundsPlayed: 10 } : {}));
    const result = calculateMatchExp(match({ players }));
    expect(find(result, "u4")).toMatchObject({ expDelta: 0, countsAsRankedMatch: false });
    expect(find(result, "u4").breakdown.rule).toBe("low_participation");
  });

  it("never counts bots as players or in team averages", () => {
    const players = [...lobby(), player(99, "team1", { isBot: true, expBefore: 5000, kills: 60 })];
    const result = calculateMatchExp(match({ players }));
    expect(result.players.some((entry) => entry.userId === "u99")).toBe(false);
    expect(result.teamRating.team1).toBe(1000);
    expect(find(result, "u1").breakdown.performance).toBe(0);
  });

  it("floors EXP at 0", () => {
    const players = lobby((id) => (id === 6 ? { expBefore: 10, kills: 2, deaths: 22 } : {}));
    const result = calculateMatchExp(match({ players }));
    expect(find(result, "u6")).toMatchObject({ expAfter: 0, expDelta: -10 });
  });

  it("never changes EXP in Fun Mode", () => {
    const result = calculateMatchExp(match({ mode: "fun" }));
    expect(result.appliesExp).toBe(false);
    expect(result.players.every((entry) => entry.expDelta === 0 && !entry.countsAsRankedMatch)).toBe(true);
  });

  it("drops a score term the plugin doesn't send and reports it", () => {
    const players = lobby(() => ({ entryKills: undefined, clutchesWon: undefined }));
    const result = calculateMatchExp(match({ players }));
    expect(result.missingTelemetry).toEqual(["entryKills", "clutchesWon"]);
    expect(result.valid).toBe(true);
  });

  it("moves Pro League access with the new EXP", () => {
    const players = lobby((id) => (id === 1 ? { expBefore: 1390, kills: 30 } : id === 6 ? { expBefore: 1360, proLeagueUnlocked: true, kills: 4, deaths: 22 } : {}));
    const result = calculateMatchExp(match({ players }));
    expect(find(result, "u1")).toMatchObject({ proLeagueUnlocked: true });
    expect(find(result, "u1").expAfter).toBeGreaterThanOrEqual(1400);
    expect(find(result, "u6").expAfter).toBeLessThan(1350);
    expect(find(result, "u6").proLeagueUnlocked).toBe(false);
  });

  it("is deterministic for the same input (idempotent recalculation)", () => {
    const input = match({ players: lobby((id) => ({ kills: 10 + id })) });
    expect(calculateMatchExp(input)).toEqual(calculateMatchExp(input));
  });
});
