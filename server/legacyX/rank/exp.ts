/**
 * Legacy-X EXP calculation (RANK-SYSTEM.md v1.0). Pure: no I/O, no clock, no randomness.
 *
 *   ΔEXP = round( C × ( Result + Margin + Performance + Bonus ) ), clamped to ±45 (±90 while calibrating)
 *
 * The result is applied atomically by legacy_x.apply_competitive_match_exp (one call per match, idempotent by
 * event id), which also floors EXP at 0 and moves Pro League access. The client never supplies EXP or rank.
 *
 * Choices the spec leaves open, fixed here so every match is computed the same way:
 * - Rounding is half away from zero, so a gain and the mirrored loss have the same size.
 * - The lobby standard deviation is the population deviation (divide by n) over every human who played a round.
 * - MVP is the highest `score` among players whose EXP is performance-based; players tied for it all get the
 *   bonus, and nobody gets it when every such player has the same score.
 * - A score term whose counter the plugin does not send (or declares unavailable) is dropped for the whole lobby
 *   and listed in `omittedTerms`; it is never guessed.
 */
import { STARTING_EXP } from "./ranks";

export const CALCULATION_VERSION = "rank-v1.0";

export type TeamKey = "team1" | "team2";
export type Outcome = "win" | "draw" | "loss";

/** Modes whose matches move EXP. Fun Mode never does. */
export const RANKED_MODES = ["5v5", "pro_league"] as const;
export type RankedMode = (typeof RANKED_MODES)[number];

export const ELO_K = 30;
export const ELO_SCALE = 400;
export const MARGIN_DIVISOR = 4;
export const MARGIN_CAP = 3;
export const PERFORMANCE_WEIGHT = 8;
export const PERFORMANCE_CAP = 8;
export const LOBBY_STD_FLOOR = 0.05;
export const BONUS_CAP = 2;
export const CALIBRATION_MATCHES = 10;
export const CALIBRATION_MULTIPLIER = 2;
export const DELTA_CAP = 45;
export const CALIBRATION_DELTA_CAP = 90;
export const LEAVER_DELTA = -25;
export const MIN_HUMAN_PLAYERS = 8;
export const MIN_ROUNDS = 13;
export const MIN_PARTICIPATION = 0.5;
export const SHORT_HANDED_ROUNDS = 3;

/** Optional score counters; each one maps to one term of `score`. */
export const OPTIONAL_COUNTERS = ["entryKills", "bombPlants", "bombDefuses", "threeKRounds", "fourKRounds", "aces", "clutchesWon", "clutchesWon1v3Plus"] as const;
export type OptionalCounter = (typeof OPTIONAL_COUNTERS)[number];

export interface MatchPlayerInput {
  steamId: string;
  /** Registered Legacy-X user; null for a human without an account (counted in the lobby at the starting EXP). */
  userId: string | null;
  team: TeamKey;
  isBot?: boolean;
  /** EXP at match start (read from progression before the match result is applied). */
  expBefore: number;
  /** Ranked matches completed before this one; decides calibration. */
  rankedMatchesBefore: number;
  /** In the team when the match started. Fills that joined mid-match are false. */
  startedMatch: boolean;
  roundsPlayed: number;
  kills: number;
  deaths: number;
  assists: number;
  entryKills?: number | null;
  bombPlants?: number | null;
  bombDefuses?: number | null;
  threeKRounds?: number | null;
  fourKRounds?: number | null;
  /** 5K rounds. */
  aces?: number | null;
  /** All clutches won, any 1vX size. */
  clutchesWon?: number | null;
  /** Clutches won against three or more opponents. */
  clutchesWon1v3Plus?: number | null;
  /** Left and did not return within the Match Core rejoin window. */
  leftEarly: boolean;
}

export interface MatchInput {
  mode: string;
  finishedNormally: boolean;
  /** Human players connected when the match ended. */
  humanPlayersAtEnd: number;
  totalRounds: number;
  roundsWon: Record<TeamKey, number>;
  /** Rounds each team played short-handed because of a leaver. */
  shortHandedRounds: Record<TeamKey, number>;
  players: MatchPlayerInput[];
  /** Counters the plugin says it cannot collect; their terms are dropped. */
  unavailableCounters?: readonly OptionalCounter[];
}

export type ExpReason = "ranked" | "leaver" | "invalid_match" | "low_participation";

export interface ExpBreakdown {
  version: string;
  reason: ExpReason;
  result: number;
  margin: number;
  performance: number;
  bonus: number;
  /** C: 2 during the first 10 ranked matches, 1 afterwards. */
  calibration: number;
  /** C × (Result + Margin + Performance + Bonus) before rounding and clamping. */
  raw: number;
  /** The delta hit the ±45 / ±90 cap. */
  capped: boolean;
  expected: number | null;
  teamRating: number;
  opponentRating: number;
  score: number | null;
  z: number | null;
  mvp: boolean;
  highlight: boolean;
  shortHandedHalved: boolean;
  omittedTerms: OptionalCounter[];
}

export interface PlayerExpResult {
  steamId: string;
  userId: string | null;
  team: TeamKey;
  outcome: Outcome;
  expBefore: number;
  expDelta: number;
  expAfter: number;
  /** Counts toward matches completed / wins / losses (and so toward calibration). */
  countsAsRanked: boolean;
  breakdown: ExpBreakdown;
}

export type InvalidReason = "unranked_mode" | "not_finished" | "too_few_humans" | "too_few_rounds";

export interface MatchExpResult {
  version: string;
  ranked: boolean;
  valid: boolean;
  invalidReasons: InvalidReason[];
  lobby: { humans: number; mean: number; std: number };
  omittedTerms: OptionalCounter[];
  players: PlayerExpResult[];
}

/** Half away from zero: round(-12.5) = -13, round(12.5) = 13. */
export function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isRankedMode(mode: string): mode is RankedMode {
  return (RANKED_MODES as readonly string[]).includes(mode);
}

/** Elo expected score of a team rated `teamRating` against `opponentRating`. */
export function expectedScore(teamRating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - teamRating) / ELO_SCALE));
}

export function outcomeScore(outcome: Outcome): number {
  return outcome === "win" ? 1 : outcome === "draw" ? 0.5 : 0;
}

/** Result = 30 × (S − E). */
export function resultComponent(outcome: Outcome, expected: number): number {
  return ELO_K * (outcomeScore(outcome) - expected);
}

/** Margin = clamp((rounds_won − rounds_lost) / 4, −3, +3). */
export function marginComponent(roundsWon: number, roundsLost: number): number {
  return clamp((roundsWon - roundsLost) / MARGIN_DIVISOR, -MARGIN_CAP, MARGIN_CAP);
}

/** Performance = clamp(round(8 × z), −8, +8). */
export function performanceComponent(z: number): number {
  return clamp(roundHalfAway(PERFORMANCE_WEIGHT * z), -PERFORMANCE_CAP, PERFORMANCE_CAP);
}

export function calibrationMultiplier(rankedMatchesBefore: number): number {
  return rankedMatchesBefore < CALIBRATION_MATCHES ? CALIBRATION_MULTIPLIER : 1;
}

/** round(C × (Result + Margin + Performance + Bonus)), clamped to ±45 or ±90 while calibrating. */
export function combineDelta(parts: { result: number; margin: number; performance: number; bonus: number; calibration: number }) {
  const raw = parts.calibration * (parts.result + parts.margin + parts.performance + parts.bonus);
  const cap = parts.calibration > 1 ? CALIBRATION_DELTA_CAP : DELTA_CAP;
  const rounded = roundHalfAway(raw);
  const delta = clamp(rounded, -cap, cap);
  return { raw, delta, capped: delta !== rounded };
}

function counterValue(player: MatchPlayerInput, counter: OptionalCounter): number {
  return Math.max(0, player[counter] ?? 0);
}

/** Terms dropped because at least one human in the lobby has no value for them. */
export function omittedCounters(players: readonly MatchPlayerInput[], declaredUnavailable: readonly OptionalCounter[] = []): OptionalCounter[] {
  return OPTIONAL_COUNTERS.filter(counter => declaredUnavailable.includes(counter) || players.some(player => player[counter] === undefined || player[counter] === null));
}

/**
 * Per-round impact score:
 * (2·K + A − D + EntryKills + Plants + Defuses + 3K + 2·4K + 3·Aces + 2·Clutches) / rounds_played.
 * Headshots are deliberately absent.
 */
export function impactScore(player: MatchPlayerInput, omitted: readonly OptionalCounter[] = []): number {
  if (player.roundsPlayed <= 0) return 0;
  const use = (counter: OptionalCounter) => (omitted.includes(counter) ? 0 : counterValue(player, counter));
  const total = 2 * player.kills + player.assists - player.deaths
    + use("entryKills")
    + use("bombPlants") + use("bombDefuses")
    + use("threeKRounds") + 2 * use("fourKRounds") + 3 * use("aces")
    + 2 * use("clutchesWon");
  return total / player.roundsPlayed;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function lobbyStats(scores: readonly number[]) {
  const mean = average(scores);
  const std = Math.sqrt(average(scores.map(score => (score - mean) ** 2)));
  return { mean, std };
}

export function zScore(score: number, mean: number, std: number): number {
  return (score - mean) / Math.max(std, LOBBY_STD_FLOOR);
}

function teamOutcome(team: TeamKey, roundsWon: Record<TeamKey, number>): Outcome {
  const own = roundsWon[team];
  const other = roundsWon[team === "team1" ? "team2" : "team1"];
  return own > other ? "win" : own < other ? "loss" : "draw";
}

function teamRating(players: readonly MatchPlayerInput[], team: TeamKey): number {
  const onTeam = players.filter(player => player.team === team);
  const starters = onTeam.filter(player => player.startedMatch);
  const pool = starters.length > 0 ? starters : onTeam;
  return pool.length > 0 ? average(pool.map(player => player.expBefore)) : STARTING_EXP;
}

export function matchInvalidReasons(match: MatchInput): InvalidReason[] {
  const reasons: InvalidReason[] = [];
  if (!isRankedMode(match.mode)) reasons.push("unranked_mode");
  if (!match.finishedNormally) reasons.push("not_finished");
  if (match.humanPlayersAtEnd < MIN_HUMAN_PLAYERS) reasons.push("too_few_humans");
  if (match.totalRounds < MIN_ROUNDS) reasons.push("too_few_rounds");
  return reasons;
}

export function calculateMatchExp(match: MatchInput): MatchExpResult {
  const humans = match.players.filter(player => !player.isBot);
  const invalidReasons = matchInvalidReasons(match);
  const ranked = isRankedMode(match.mode);
  const valid = invalidReasons.length === 0;
  const omitted = omittedCounters(humans, match.unavailableCounters);

  const ratings: Record<TeamKey, number> = { team1: teamRating(humans, "team1"), team2: teamRating(humans, "team2") };
  const played = humans.filter(player => player.roundsPlayed > 0);
  const scores = new Map(played.map(player => [player.steamId, impactScore(player, omitted)]));
  const { mean, std } = lobbyStats([...scores.values()]);

  const participates = (player: MatchPlayerInput) =>
    !player.leftEarly && match.totalRounds > 0 && player.roundsPlayed / match.totalRounds >= MIN_PARTICIPATION;
  const performers = valid ? humans.filter(participates) : [];
  const performerScores = performers.map(player => scores.get(player.steamId) ?? 0);
  const topScore = performerScores.length > 0 ? Math.max(...performerScores) : null;
  const everyoneTied = performerScores.length > 0 && performerScores.every(score => score === topScore);

  const players = humans.map((player): PlayerExpResult => {
    const opponent: TeamKey = player.team === "team1" ? "team2" : "team1";
    const base = {
      version: CALCULATION_VERSION,
      teamRating: ratings[player.team],
      opponentRating: ratings[opponent],
      omittedTerms: omitted,
    };
    const zero = { result: 0, margin: 0, performance: 0, bonus: 0, raw: 0, capped: false, expected: null, score: scores.get(player.steamId) ?? null, z: null, mvp: false, highlight: false, shortHandedHalved: false };
    const finish = (outcome: Outcome, expDelta: number, countsAsRanked: boolean, breakdown: ExpBreakdown): PlayerExpResult => {
      const expAfter = Math.max(0, player.expBefore + expDelta);
      return { steamId: player.steamId, userId: player.userId, team: player.team, outcome, expBefore: player.expBefore, expDelta: expAfter - player.expBefore, expAfter, countsAsRanked, breakdown };
    };

    // Fun Mode (and anything else unranked) never changes EXP, not even for a leaver.
    if (!ranked) return finish(teamOutcome(player.team, match.roundsWon), 0, false, { ...base, ...zero, reason: "invalid_match", calibration: 1 });

    if (player.leftEarly) {
      // Fixed penalty, no performance, counted as a loss — also in a match that is otherwise invalid.
      return finish("loss", LEAVER_DELTA, true, { ...base, ...zero, reason: "leaver", calibration: 1, raw: LEAVER_DELTA });
    }

    const outcome = teamOutcome(player.team, match.roundsWon);
    if (!valid) return finish(outcome, 0, false, { ...base, ...zero, reason: "invalid_match", calibration: 1 });
    if (!participates(player)) return finish(outcome, 0, false, { ...base, ...zero, reason: "low_participation", calibration: 1 });

    const expected = expectedScore(ratings[player.team], ratings[opponent]);
    let result = resultComponent(outcome, expected);
    const shortHandedHalved = result < 0 && match.shortHandedRounds[player.team] >= SHORT_HANDED_ROUNDS;
    if (shortHandedHalved) result /= 2;
    const margin = marginComponent(match.roundsWon[player.team], match.roundsWon[opponent]);
    const score = scores.get(player.steamId) ?? 0;
    const z = zScore(score, mean, std);
    const performance = performanceComponent(z);
    const highlight = (!omitted.includes("aces") && counterValue(player, "aces") > 0)
      || (!omitted.includes("clutchesWon1v3Plus") && counterValue(player, "clutchesWon1v3Plus") > 0);
    const mvp = !everyoneTied && topScore !== null && score === topScore;
    const bonus = Math.min(BONUS_CAP, (highlight ? 1 : 0) + (mvp ? 1 : 0));
    const calibration = calibrationMultiplier(player.rankedMatchesBefore);
    const { raw, delta, capped } = combineDelta({ result, margin, performance, bonus, calibration });
    return finish(outcome, delta, true, { ...base, reason: "ranked", result, margin, performance, bonus, calibration, raw, capped, expected, score, z, mvp, highlight, shortHandedHalved });
  });

  return { version: CALCULATION_VERSION, ranked, valid, invalidReasons, lobby: { humans: played.length, mean, std }, omittedTerms: omitted, players };
}
