import { describe, expect, it } from "vitest";
import {
  CALCULATION_VERSION,
  calculateMatchExp,
  calibrationMultiplier,
  combineDelta,
  expectedScore,
  impactScore,
  lobbyStats,
  marginComponent,
  performanceComponent,
  resultComponent,
  roundHalfAway,
  zScore,
  type MatchInput,
  type MatchPlayerInput,
  type TeamKey,
} from "./exp";

function player(steamId: string, team: TeamKey, overrides: Partial<MatchPlayerInput> = {}): MatchPlayerInput {
  return {
    steamId,
    userId: `user-${steamId}`,
    team,
    expBefore: 1000,
    rankedMatchesBefore: 20,
    startedMatch: true,
    roundsPlayed: 22,
    kills: 15,
    deaths: 15,
    assists: 4,
    entryKills: 2,
    bombPlants: 1,
    bombDefuses: 0,
    threeKRounds: 1,
    fourKRounds: 0,
    aces: 0,
    clutchesWon: 0,
    clutchesWon1v3Plus: 0,
    leftEarly: false,
    ...overrides,
  };
}

/** Ten identical players: every z is 0, so only Result and Margin move EXP. */
function evenLobby(overrides: { team1?: Partial<MatchPlayerInput>; team2?: Partial<MatchPlayerInput> } = {}): MatchPlayerInput[] {
  return [
    ...Array.from({ length: 5 }, (_, index) => player(`7656119800000000${index}`, "team1", overrides.team1)),
    ...Array.from({ length: 5 }, (_, index) => player(`7656119800000001${index}`, "team2", overrides.team2)),
  ];
}

function match(players: MatchPlayerInput[], overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    mode: "5v5",
    finishedNormally: true,
    humanPlayersAtEnd: players.filter(entry => !entry.isBot && !entry.leftEarly).length,
    totalRounds: 22,
    roundsWon: { team1: 13, team2: 9 },
    shortHandedRounds: { team1: 0, team2: 0 },
    players,
    ...overrides,
  };
}

function deltaOf(result: ReturnType<typeof calculateMatchExp>, steamId: string) {
  const entry = result.players.find(candidate => candidate.steamId === steamId);
  if (!entry) throw new Error(`no result for ${steamId}`);
  return entry;
}

describe("formula components", () => {
  it("reproduces the worked example in RANK-SYSTEM.md section 5", () => {
    const expectedA = expectedScore(1200, 1300);
    expect(expectedA).toBeCloseTo(0.36, 2);
    const winResult = resultComponent("win", expectedA);
    const lossResult = resultComponent("loss", 1 - expectedA);
    expect(winResult).toBeCloseTo(19.2, 1);
    expect(lossResult).toBeCloseTo(-19.2, 1);
    expect(marginComponent(13, 9)).toBe(1);
    expect(marginComponent(9, 13)).toBe(-1);

    const topA = combineDelta({ result: winResult, margin: 1, performance: performanceComponent(1.2), bonus: 1, calibration: 1 });
    const weakA = combineDelta({ result: winResult, margin: 1, performance: performanceComponent(-1.0), bonus: 0, calibration: 1 });
    const bestB = combineDelta({ result: lossResult, margin: -1, performance: performanceComponent(1.5), bonus: 0, calibration: 1 });
    const weakB = combineDelta({ result: lossResult, margin: -1, performance: performanceComponent(-1.2), bonus: 0, calibration: 1 });
    expect([topA.delta, weakA.delta, bestB.delta, weakB.delta]).toEqual([29, 12, -12, -28]);
  });

  it("gives ±15 for a win or loss between equal teams", () => {
    expect(resultComponent("win", expectedScore(1000, 1000))).toBe(15);
    expect(resultComponent("loss", expectedScore(1000, 1000))).toBe(-15);
  });

  it("scores a draw as half a win", () => {
    expect(resultComponent("draw", expectedScore(1000, 1000))).toBe(0);
    expect(resultComponent("draw", expectedScore(1000, 1200))).toBeGreaterThan(0);
    expect(resultComponent("draw", expectedScore(1200, 1000))).toBeLessThan(0);
  });

  it("caps the margin at ±3", () => {
    expect(marginComponent(13, 0)).toBe(3);
    expect(marginComponent(0, 13)).toBe(-3);
    expect(marginComponent(13, 11)).toBe(0.5);
  });

  it("caps performance at ±8 and rounds 8·z", () => {
    expect(performanceComponent(0.3)).toBe(2);
    expect(performanceComponent(-0.3)).toBe(-2);
    expect(performanceComponent(5)).toBe(8);
    expect(performanceComponent(-5)).toBe(-8);
  });

  it("floors the lobby deviation at 0.05", () => {
    expect(zScore(1.1, 1.0, 0)).toBeCloseTo(2, 10);
    expect(zScore(1.1, 1.0, 0.01)).toBeCloseTo(2, 10);
    expect(zScore(1.1, 1.0, 0.2)).toBeCloseTo(0.5, 10);
  });

  it("uses the population mean and deviation of the lobby", () => {
    const { mean, std } = lobbyStats([1, 2, 3, 4]);
    expect(mean).toBe(2.5);
    expect(std).toBeCloseTo(Math.sqrt(1.25), 10);
  });

  it("calibrates the first 10 ranked matches", () => {
    expect(calibrationMultiplier(0)).toBe(2);
    expect(calibrationMultiplier(9)).toBe(2);
    expect(calibrationMultiplier(10)).toBe(1);
  });

  it("clamps to ±45, or ±90 while calibrating", () => {
    expect(combineDelta({ result: 40, margin: 3, performance: 8, bonus: 2, calibration: 1 })).toMatchObject({ delta: 45, capped: true });
    expect(combineDelta({ result: -40, margin: -3, performance: -8, bonus: 0, calibration: 1 })).toMatchObject({ delta: -45, capped: true });
    expect(combineDelta({ result: 40, margin: 3, performance: 8, bonus: 2, calibration: 2 })).toMatchObject({ delta: 90, capped: true });
    expect(combineDelta({ result: 10, margin: 1, performance: 2, bonus: 0, calibration: 2 })).toMatchObject({ delta: 26, capped: false });
  });

  it("rounds halves away from zero so gains and losses mirror", () => {
    expect(roundHalfAway(12.5)).toBe(13);
    expect(roundHalfAway(-12.5)).toBe(-13);
    expect(roundHalfAway(-12.4)).toBe(-12);
  });

  it("builds the impact score from the spec's weights, without headshots", () => {
    const base = player("1", "team1", { roundsPlayed: 10, kills: 10, deaths: 5, assists: 3, entryKills: 2, bombPlants: 1, bombDefuses: 1, threeKRounds: 1, fourKRounds: 1, aces: 1, clutchesWon: 2 });
    // 2·10 + 3 − 5 + 2 + (1 + 1) + 1 + 2·1 + 3·1 + 2·2 = 32
    expect(impactScore(base)).toBeCloseTo(3.2, 10);
    expect(impactScore(base, ["entryKills", "clutchesWon"])).toBeCloseTo(2.6, 10);
  });
});

describe("calculateMatchExp", () => {
  it("gives +16/−16 in an even lobby of equal teams at 13–9 (Result ±15, Margin ±1)", () => {
    const result = calculateMatchExp(match(evenLobby()));
    expect(result.valid).toBe(true);
    for (const entry of result.players) {
      expect(entry.expDelta).toBe(entry.team === "team1" ? 16 : -16);
      expect(entry.breakdown.performance).toBe(0);
      expect(entry.breakdown.bonus).toBe(0);
      expect(entry.breakdown.version).toBe(CALCULATION_VERSION);
    }
  });

  it("rewards beating a stronger team and punishes losing to a weaker one", () => {
    const result = calculateMatchExp(match(evenLobby({ team1: { expBefore: 1200 }, team2: { expBefore: 1400 } })));
    const winner = deltaOf(result, "76561198000000000");
    const loser = deltaOf(result, "76561198000000010");
    expect(winner.breakdown.result).toBeGreaterThan(15);
    expect(loser.breakdown.result).toBeLessThan(-15);
    expect(winner.expDelta).toBe(roundHalfAway(30 * (1 - expectedScore(1200, 1400)) + 1));
    expect(loser.expDelta).toBe(roundHalfAway(30 * (0 - expectedScore(1400, 1200)) - 1));
  });

  it("treats a tied scoreline as a draw", () => {
    const result = calculateMatchExp(match(evenLobby(), { roundsWon: { team1: 12, team2: 12 }, totalRounds: 24 }));
    for (const entry of result.players) {
      expect(entry.outcome).toBe("draw");
      expect(entry.expDelta).toBe(0);
    }
  });

  it("moves individual EXP by lobby-relative performance", () => {
    const players = evenLobby();
    players[0] = player("76561198000000000", "team1", { kills: 30, deaths: 10 });
    players[9] = player("76561198000000014", "team2", { kills: 5, deaths: 20 });
    const result = calculateMatchExp(match(players));
    const star = deltaOf(result, "76561198000000000");
    const weak = deltaOf(result, "76561198000000014");
    expect(star.breakdown.performance).toBe(8);
    expect(star.breakdown.mvp).toBe(true);
    expect(star.expDelta).toBe(16 + 8 + 1);
    expect(weak.breakdown.performance).toBe(-8);
    expect(weak.expDelta).toBe(-16 - 8);
    const scores = result.players.map(entry => entry.breakdown.score!);
    expect(result.lobby.mean).toBeCloseTo(scores.reduce((sum, value) => sum + value, 0) / scores.length, 10);
  });

  it("caps the bonus at +2 (highlight + MVP)", () => {
    const players = evenLobby();
    players[0] = player("76561198000000000", "team1", { kills: 30, deaths: 10, aces: 2, clutchesWon1v3Plus: 1 });
    const star = deltaOf(calculateMatchExp(match(players)), "76561198000000000");
    expect(star.breakdown.highlight).toBe(true);
    expect(star.breakdown.mvp).toBe(true);
    expect(star.breakdown.bonus).toBe(2);
  });

  it("gives the highlight bonus for a 1v3+ clutch without an ace", () => {
    const players = evenLobby();
    players[3] = player("76561198000000003", "team1", { clutchesWon1v3Plus: 1 });
    const clutcher = deltaOf(calculateMatchExp(match(players)), "76561198000000003");
    expect(clutcher.breakdown.highlight).toBe(true);
  });

  it("doubles EXP for a calibrating player and allows up to ±90", () => {
    const players = evenLobby({ team1: { rankedMatchesBefore: 3 } });
    const result = calculateMatchExp(match(players));
    expect(deltaOf(result, "76561198000000000").expDelta).toBe(32);
    expect(deltaOf(result, "76561198000000000").breakdown.calibration).toBe(2);
    expect(deltaOf(result, "76561198000000010").expDelta).toBe(-16);
    expect(deltaOf(result, "76561198000000010").breakdown.calibration).toBe(1);
  });

  it("stops calibrating after the 10th ranked match", () => {
    const players = evenLobby({ team1: { rankedMatchesBefore: 10 } });
    expect(deltaOf(calculateMatchExp(match(players)), "76561198000000000").expDelta).toBe(16);
  });

  it("gives a leaver exactly −25, no performance, counted as a loss", () => {
    const players = evenLobby();
    players[1] = player("76561198000000001", "team1", { leftEarly: true, roundsPlayed: 6, kills: 20 });
    const result = calculateMatchExp(match(players, { humanPlayersAtEnd: 9 }));
    const leaver = deltaOf(result, "76561198000000001");
    expect(leaver.expDelta).toBe(-25);
    expect(leaver.outcome).toBe("loss");
    expect(leaver.countsAsRanked).toBe(true);
    expect(leaver.breakdown.reason).toBe("leaver");
    expect(leaver.breakdown.performance).toBe(0);
    expect(leaver.breakdown.mvp).toBe(false);
  });

  it("keeps the leaver penalty in a match that does not count", () => {
    const players = evenLobby();
    players[1] = player("76561198000000001", "team1", { leftEarly: true, roundsPlayed: 3 });
    const result = calculateMatchExp(match(players, { totalRounds: 10, roundsWon: { team1: 6, team2: 4 } }));
    expect(result.valid).toBe(false);
    expect(deltaOf(result, "76561198000000001").expDelta).toBe(-25);
    expect(deltaOf(result, "76561198000000000").expDelta).toBe(0);
  });

  it("halves only the loss Result for a team that played 3+ rounds short-handed", () => {
    const shortLoss = calculateMatchExp(match(evenLobby(), { roundsWon: { team1: 9, team2: 13 }, shortHandedRounds: { team1: 3, team2: 0 } }));
    const normalLoss = calculateMatchExp(match(evenLobby(), { roundsWon: { team1: 9, team2: 13 } }));
    const shortPlayer = deltaOf(shortLoss, "76561198000000000");
    expect(shortPlayer.breakdown.shortHandedHalved).toBe(true);
    expect(shortPlayer.breakdown.result).toBe(-7.5);
    expect(shortPlayer.expDelta).toBe(roundHalfAway(-7.5 - 1));
    expect(deltaOf(normalLoss, "76561198000000000").expDelta).toBe(-16);

    const shortWin = calculateMatchExp(match(evenLobby(), { shortHandedRounds: { team1: 5, team2: 0 } }));
    expect(deltaOf(shortWin, "76561198000000000").breakdown.shortHandedHalved).toBe(false);
    expect(deltaOf(shortWin, "76561198000000000").expDelta).toBe(16);

    const twoRoundsShort = calculateMatchExp(match(evenLobby(), { roundsWon: { team1: 9, team2: 13 }, shortHandedRounds: { team1: 2, team2: 0 } }));
    expect(deltaOf(twoRoundsShort, "76561198000000000").breakdown.shortHandedHalved).toBe(false);
  });

  it.each([
    ["not finished", { finishedNormally: false }, "not_finished"],
    ["fewer than 8 humans", { humanPlayersAtEnd: 7 }, "too_few_humans"],
    ["fewer than 13 rounds", { totalRounds: 12, roundsWon: { team1: 7, team2: 5 } }, "too_few_rounds"],
  ] as const)("applies 0 to everyone when the match is invalid (%s) but keeps the history row", (_label, overrides, reason) => {
    const result = calculateMatchExp(match(evenLobby(), overrides as Partial<MatchInput>));
    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain(reason);
    expect(result.players).toHaveLength(10);
    for (const entry of result.players) {
      expect(entry.expDelta).toBe(0);
      expect(entry.countsAsRanked).toBe(false);
      expect(entry.breakdown.reason).toBe("invalid_match");
    }
  });

  it("counts a match with 8 humans at the end (not exactly 10)", () => {
    expect(calculateMatchExp(match(evenLobby(), { humanPlayersAtEnd: 8 })).valid).toBe(true);
  });

  it("never changes EXP in Fun Mode, not even for a leaver", () => {
    const players = evenLobby();
    players[1] = player("76561198000000001", "team1", { leftEarly: true });
    const result = calculateMatchExp(match(players, { mode: "fun" }));
    expect(result.ranked).toBe(false);
    expect(result.invalidReasons).toContain("unranked_mode");
    expect(result.players.every(entry => entry.expDelta === 0)).toBe(true);
  });

  it("counts fills normally for the rounds they played, but not in the team rating", () => {
    const players = evenLobby({ team1: { expBefore: 1000 }, team2: { expBefore: 1000 } });
    players[4] = player("76561198000000004", "team1", { roundsPlayed: 8, leftEarly: true, expBefore: 1000 });
    players.push(player("76561198000000099", "team1", { startedMatch: false, roundsPlayed: 14, expBefore: 2000, kills: 10 }));
    const result = calculateMatchExp(match(players));
    const fill = deltaOf(result, "76561198000000099");
    expect(fill.breakdown.teamRating).toBe(1000);
    expect(fill.breakdown.reason).toBe("ranked");
    expect(fill.countsAsRanked).toBe(true);
    expect(fill.breakdown.score).toBeCloseTo(impactScore(players[10]!), 10);
  });

  it("excludes bots from the lobby, the team ratings and the results", () => {
    const players = evenLobby();
    players.push(player("BOT1", "team2", { isBot: true, expBefore: 5000, kills: 40, deaths: 0 }));
    const result = calculateMatchExp(match(players));
    expect(result.players.find(entry => entry.steamId === "BOT1")).toBeUndefined();
    expect(result.lobby.humans).toBe(10);
    expect(deltaOf(result, "76561198000000010").breakdown.teamRating).toBe(1000);
    expect(deltaOf(result, "76561198000000000").expDelta).toBe(16);
  });

  it("gives 0 to a player present for under 50% of rounds", () => {
    const players = evenLobby();
    players[2] = player("76561198000000002", "team1", { roundsPlayed: 10 });
    const result = calculateMatchExp(match(players));
    const partial = deltaOf(result, "76561198000000002");
    expect(partial.expDelta).toBe(0);
    expect(partial.countsAsRanked).toBe(false);
    expect(partial.breakdown.reason).toBe("low_participation");
    expect(deltaOf(calculateMatchExp(match(evenLobby({ team1: { roundsPlayed: 11 } }))), "76561198000000000").breakdown.reason).toBe("ranked");
  });

  it("floors EXP at 0", () => {
    const players = evenLobby({ team1: { expBefore: 10 }, team2: { expBefore: 10 } });
    const result = calculateMatchExp(match(players));
    const loser = deltaOf(result, "76561198000000010");
    expect(loser.expAfter).toBe(0);
    expect(loser.expDelta).toBe(-10);

    const leaverAtZero = evenLobby();
    leaverAtZero[0] = player("76561198000000000", "team1", { leftEarly: true, expBefore: 0 });
    expect(deltaOf(calculateMatchExp(match(leaverAtZero)), "76561198000000000")).toMatchObject({ expDelta: 0, expAfter: 0 });
  });

  it("drops score terms the plugin does not send and says so", () => {
    const players = evenLobby({ team1: { entryKills: null }, team2: { entryKills: undefined } });
    const result = calculateMatchExp(match(players, { unavailableCounters: ["bombPlants"] }));
    expect(result.omittedTerms).toEqual(["entryKills", "bombPlants"]);
    expect(result.players[0]!.breakdown.omittedTerms).toEqual(["entryKills", "bombPlants"]);
  });

  it("does not hand out MVP when every performer scores the same", () => {
    const result = calculateMatchExp(match(evenLobby()));
    expect(result.players.some(entry => entry.breakdown.mvp)).toBe(false);
  });
});
