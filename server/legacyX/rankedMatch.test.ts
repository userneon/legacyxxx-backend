import { describe, expect, it } from "vitest";

import { calculateMatchExp } from "./ranking";
import { buildRankedInput, isLeaver, rankedResultSchema, type MatchParticipant } from "./rankedMatch";

const finishedAt = new Date("2026-09-24T12:00:00Z");

function participant(index: number, team: "team1" | "team2", overrides: Partial<MatchParticipant> = {}): MatchParticipant {
  return {
    user_id: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
    steam_id: `765611980000000${String(index).padStart(2, "0")}`,
    team_key: team,
    connected: true,
    disconnected_at: null,
    returned_at: null,
    reconnect_deadline: null,
    ...overrides,
  };
}

const roster = Array.from({ length: 10 }, (_, index) => participant(index + 1, index < 5 ? "team1" : "team2"));

function stats(kills: number, extra: Record<string, number> = {}) {
  return { kills, deaths: 15, assists: 3, headshot_kills: 6, rounds_played: 22, bomb_plants: 1, bomb_defuses: 0, "3k": 1, "4k": 0, "5k": 0, "1v1": 0, "1v2": 0, "1v3": 0, "1v4": 0, "1v5": 0, first_kills_t: 1, first_kills_ct: 1, ...extra };
}

function payload(overrides: Record<string, unknown> = {}) {
  return rankedResultSchema.parse({
    winner_team: "team1",
    team1_rounds: 13,
    team2_rounds: 9,
    rank_result: {
      team1: { players: roster.slice(0, 5).map((row, index) => ({ steamid: row.steam_id, name: `p${index}`, stats: stats(20 - index) })) },
      team2: { players: roster.slice(5).map((row, index) => ({ steamid: row.steam_id, name: `q${index}`, stats: stats(15 - index) })) },
    },
    ...overrides,
  });
}

describe("buildRankedInput", () => {
  it("maps MatchZy stats onto the formula's terms", () => {
    const built = buildRankedInput(payload(), roster, [], finishedAt);
    expect(built.unrankable).toEqual([]);
    const first = built.input.players[0];
    expect(first).toMatchObject({ kills: 20, deaths: 15, assists: 3, roundsPlayed: 22, entryKills: 2, bombPlants: 1, threeKRounds: 1, aces: 0, expBefore: 1000, rankedMatchesBefore: 0 });
    expect(first.clutchesWon).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(built.input.roundsWon).toEqual({ team1: 13, team2: 9 });
    expect(built.input.humanPlayersAtEnd).toBe(10);
  });

  it("refuses to rank without a round score or player stats", () => {
    expect(buildRankedInput(payload({ team1_rounds: undefined, team2_rounds: undefined }), roster, [], finishedAt).unrankable).toContain("missing_round_score");
    expect(buildRankedInput(payload({ rank_result: null }), roster, [], finishedAt).unrankable).toContain("missing_player_stats");
  });

  it("uses each player's stored EXP and ranked match count", () => {
    const progression = [{ user_id: roster[0]!.user_id, current_exp: 1420, matches_completed: 30, pro_league_unlocked: true }];
    const first = buildRankedInput(payload(), roster, progression, finishedAt).input.players[0];
    expect(first).toMatchObject({ expBefore: 1420, rankedMatchesBefore: 30, proLeagueUnlocked: true });
  });

  it("marks a player who dropped and missed the rejoin window as a leaver, and the team short-handed", () => {
    const left = participant(8, "team2", { connected: false, disconnected_at: "2026-09-24T11:20:00Z", reconnect_deadline: "2026-09-24T11:25:00Z" });
    const players = roster.map((row) => (row.user_id === left.user_id ? left : row));
    const result = payload();
    result.rank_result!.team2.players[2]!.stats = stats(3, { rounds_played: 6 });
    const built = buildRankedInput(result, players, [], finishedAt);
    const leaver = built.input.players.find((player) => player.userId === left.user_id)!;
    expect(leaver.leftEarly).toBe(true);
    expect(built.input.shortHandedRounds?.team2).toBe(16);
    expect(built.input.humanPlayersAtEnd).toBe(9);

    const exp = calculateMatchExp(built.input);
    expect(exp.players.find((player) => player.userId === left.user_id)!.expDelta).toBe(-25);
  });

  it("does not treat a player who came back, or is still inside the window, as a leaver", () => {
    expect(isLeaver(participant(1, "team1", { connected: true, disconnected_at: "2026-09-24T11:20:00Z", returned_at: "2026-09-24T11:21:00Z" }), finishedAt)).toBe(false);
    expect(isLeaver(participant(1, "team1", { connected: false, disconnected_at: "2026-09-24T11:59:00Z", reconnect_deadline: "2026-09-24T12:04:00Z" }), finishedAt)).toBe(false);
  });

  it("reports stats the plugin never sent", () => {
    const result = payload();
    for (const team of ["team1", "team2"] as const) {
      for (const player of result.rank_result![team].players) player.stats = { kills: 10, deaths: 10, assists: 2, rounds_played: 22 };
    }
    const exp = calculateMatchExp(buildRankedInput(result, roster, [], finishedAt).input);
    expect(exp.missingTelemetry).toEqual(["entryKills", "bombPlants", "bombDefuses", "threeKRounds", "fourKRounds", "aces", "clutchesWon"]);
  });

  it("never ranks Fun Mode", () => {
    const exp = calculateMatchExp(buildRankedInput(payload({ mode: "fun" }), roster, [], finishedAt).input);
    expect(exp.appliesExp).toBe(false);
  });
});

describe("competitive_result v2 (current plugins)", () => {
  const v2Player = (index: number, team: "team1" | "team2", extra: Record<string, unknown> = {}) => ({
    steam_id: `765611980000000${String(index).padStart(2, "0")}`,
    team,
    is_bot: false,
    fill: false,
    rounds_played: 22,
    kills: 18 - index,
    deaths: 14,
    assists: 4,
    headshot_kills: 7,
    entry_kills: 2,
    bomb_plants: 1,
    bomb_defuses: 0,
    rounds_3k: 1,
    rounds_4k: 0,
    rounds_5k: 0,
    clutches_won: 1,
    clutches_won_1v3_plus: 0,
    mvps: 2,
    left_early: false,
    left_at_round: null,
    ...extra,
  });
  const v2 = (overrides: Record<string, unknown> = {}, players = Array.from({ length: 10 }, (_, index) => v2Player(index + 1, index < 5 ? "team1" : "team2"))) => rankedResultSchema.parse({
    winner_team: "team1",
    competitive_result: { schema_version: 2, mode: "5v5", finished_normally: true, human_players_at_end: 10, total_rounds: 22, team1: { rounds_won: 13 }, team2: { rounds_won: 9 }, unavailable_fields: [], players, ...overrides },
  });

  it("maps v2 telemetry onto the rank formula and applies EXP", () => {
    const built = buildRankedInput(v2(), roster, [], finishedAt);
    expect(built.unrankable).toEqual([]);
    expect(built.input).toMatchObject({ mode: "5v5", finishedNormally: true, roundsWon: { team1: 13, team2: 9 }, humanPlayersAtEnd: 10 });
    expect(built.input.players[0]).toMatchObject({ kills: 17, entryKills: 2, threeKRounds: 1, clutchesWon: { 1: 1, 3: 0 } });
    const outcome = calculateMatchExp(built.input);
    expect(outcome.appliesExp).toBe(true);
    expect(outcome.players.filter((player) => player.team === "team1").every((player) => player.expDelta > 0)).toBe(true);
  });

  it("drops unavailable counters and derives short-handed rounds from left_at_round", () => {
    const players = Array.from({ length: 10 }, (_, index) => v2Player(index + 1, index < 5 ? "team1" : "team2", index === 7 ? { left_early: true, left_at_round: 10, rounds_played: 10 } : {}));
    const built = buildRankedInput(v2({ unavailable_fields: ["bomb_plants"] }, players), roster, [], finishedAt);
    expect(built.input.players[0]!.bombPlants).toBeUndefined();
    expect(built.input.players[7]!.leftEarly).toBe(true);
    expect(built.input.shortHandedRounds).toEqual({ team1: 0, team2: 12 });
  });

  it("maps pro_league and fun, and rejects malformed telemetry", () => {
    expect(buildRankedInput(v2({ mode: "pro_league" }), roster, [], finishedAt).input.mode).toBe("pro");
    expect(buildRankedInput(v2({ mode: "fun" }), roster, [], finishedAt).input.mode).toBe("fun");
    expect(buildRankedInput(v2({ total_rounds: 5 }), roster, [], finishedAt).unrankable).toEqual(["invalid_competitive_result"]);
  });
});
