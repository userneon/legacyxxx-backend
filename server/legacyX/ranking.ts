/**
 * Legacy-X rank system v1.0 — the EXP formula from docs/design/RANK-SYSTEM.md.
 *
 * Pure functions only: no database, no clock, no randomness. The route layer loads the
 * players' EXP at match start, calls {@link calculateMatchExp}, and hands the result to
 * `legacy_x.apply_competitive_match_exp`, which applies every delta in one transaction.
 *
 *   ΔEXP = round( C × ( Result + Margin + Performance + Bonus ) ), clamped to ±45 (±90 calibrating)
 */

export const RANK_CALCULATION_VERSION = "legacyx-exp-1.0";
export const STARTING_EXP = 1000;
export const PRO_LEAGUE_UNLOCK_EXP = 1400;
export const PRO_LEAGUE_KEEP_EXP = 1350;
export const LEAVER_DELTA = -25;
export const CALIBRATION_MATCHES = 10;
export const MIN_HUMAN_PLAYERS = 8;
export const MIN_ROUNDS = 13;
export const MIN_PARTICIPATION = 0.5;
export const SHORT_HANDED_ROUNDS = 3;
export const ELO_K = 30;
export const MARGIN_CAP = 3;
export const PERFORMANCE_CAP = 8;
export const PERFORMANCE_STD_FLOOR = 0.05;
export const BONUS_CAP = 2;
export const DELTA_CAP = 45;
export const DELTA_CAP_CALIBRATING = 90;

export type RankTier = "recruit" | "operator" | "vanguard" | "ace" | "apex" | "legacy";

export interface RankDefinition {
  id: number;
  slug: string;
  name: string;
  tier: RankTier;
  minExp: number;
  imageKey: string;
}

const rank = (id: number, name: string, tier: RankTier, minExp: number): RankDefinition => ({
  id,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  name,
  tier,
  minExp,
  imageKey: `rank-${String(id).padStart(2, "0")}`,
});

/** Section 4 of the spec: the highest threshold the EXP has reached is the rank. */
export const RANKS: readonly RankDefinition[] = [
  rank(1, "Recruit I", "recruit", 0),
  rank(2, "Recruit II", "recruit", 600),
  rank(3, "Recruit III", "recruit", 700),
  rank(4, "Recruit IV", "recruit", 800),
  rank(5, "Recruit V", "recruit", 900),
  rank(6, "Recruit VI", "recruit", 950),
  rank(7, "Operator I", "operator", 1000),
  rank(8, "Operator II", "operator", 1100),
  rank(9, "Operator III", "operator", 1200),
  rank(10, "Operator IV", "operator", 1300),
  rank(11, "Vanguard I", "vanguard", 1400),
  rank(12, "Vanguard II", "vanguard", 1500),
  rank(13, "Vanguard III", "vanguard", 1600),
  rank(14, "Vanguard IV", "vanguard", 1700),
  rank(15, "Ace I", "ace", 1800),
  rank(16, "Ace II", "ace", 1950),
  rank(17, "Apex", "apex", 2100),
  rank(18, "Legacy", "legacy", 2300),
];

export function rankForExp(exp: number): RankDefinition {
  const value = Math.max(0, exp);
  let current = RANKS[0];
  for (const definition of RANKS) if (definition.minExp <= value) current = definition;
  return current;
}

export function nextRankForExp(exp: number): RankDefinition | null {
  return RANKS.find((definition) => definition.minExp > Math.max(0, exp)) ?? null;
}

/** Pro League unlocks at 1400 and is only taken away below 1350, so players don't flip in and out. */
export function proLeagueAccess(previouslyUnlocked: boolean, exp: number): boolean {
  if (exp >= PRO_LEAGUE_UNLOCK_EXP) return true;
  return previouslyUnlocked && exp >= PRO_LEAGUE_KEEP_EXP;
}

export type TeamKey = "team1" | "team2";
export type RankedMode = "5v5" | "pro" | "fun";

/** Stats as the plugin reports them. `undefined` means "not sent", which drops that term from the score. */
export interface PlayerMatchStats {
  roundsPlayed: number;
  kills: number;
  deaths: number;
  assists: number;
  entryKills?: number;
  bombPlants?: number;
  bombDefuses?: number;
  threeKRounds?: number;
  fourKRounds?: number;
  aces?: number;
  /** Clutches won, keyed by the number of opponents (1v1 … 1v5). */
  clutchesWon?: Partial<Record<1 | 2 | 3 | 4 | 5, number>>;
}

export interface RankedPlayerInput extends PlayerMatchStats {
  userId: string;
  steamId: string;
  team: TeamKey;
  isBot?: boolean;
  /** EXP at match start. */
  expBefore: number;
  /** Ranked matches already completed before this one (drives calibration). */
  rankedMatchesBefore: number;
  proLeagueUnlocked?: boolean;
  /** Left and did not return within the Match Core rejoin window. */
  leftEarly?: boolean;
}

export interface RankedMatchInput {
  mode: RankedMode;
  finishedNormally: boolean;
  roundsWon: Record<TeamKey, number>;
  humanPlayersAtEnd: number;
  /** Rounds each team played a player short because of a leaver. */
  shortHandedRounds?: Partial<Record<TeamKey, number>>;
  players: RankedPlayerInput[];
}

export interface ExpBreakdown {
  result: number;
  margin: number;
  performance: number;
  bonus: number;
  calibration: 1 | 2;
  /** Why the formula was not applied to this player, when it wasn't. */
  rule?: "leaver" | "invalid_match" | "low_participation" | "fun_mode";
  expected?: number;
  score?: number;
  z?: number;
  shortHanded?: boolean;
  mvp?: boolean;
}

export interface PlayerExpResult {
  userId: string;
  steamId: string;
  team: TeamKey;
  expBefore: number;
  expDelta: number;
  expAfter: number;
  rankBefore: RankDefinition;
  rankAfter: RankDefinition;
  proLeagueUnlocked: boolean;
  /** Counts toward matches played and calibration (valid match, enough rounds, not a leaver). */
  countsAsRankedMatch: boolean;
  outcome: "win" | "draw" | "loss";
  breakdown: ExpBreakdown;
}

export interface MatchExpResult {
  version: string;
  mode: RankedMode;
  /** False when the mode never changes EXP (Fun). Nothing should be persisted as a ranked result. */
  appliesExp: boolean;
  valid: boolean;
  invalidReasons: string[];
  /** Score terms the plugin did not send; they were left out of `score` rather than guessed. */
  missingTelemetry: string[];
  totalRounds: number;
  teamRating: Record<TeamKey, number>;
  players: PlayerExpResult[];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;
const otherTeam = (team: TeamKey): TeamKey => (team === "team1" ? "team2" : "team1");

/** Elo expectation of `team` beating `opponent` from their average EXP. */
export function expectedScore(teamRating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - teamRating) / 400));
}

export function marginTerm(roundsWon: number, roundsLost: number): number {
  return clamp((roundsWon - roundsLost) / 4, -MARGIN_CAP, MARGIN_CAP);
}

const SCORE_TERMS = ["entryKills", "bombPlants", "bombDefuses", "threeKRounds", "fourKRounds", "aces", "clutchesWon"] as const;

/** Per-round impact score. Terms whose stat is missing contribute nothing. */
export function impactScore(stats: PlayerMatchStats): number {
  const rounds = Math.max(1, stats.roundsPlayed);
  const clutches = Object.values(stats.clutchesWon ?? {}).reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const total =
    2 * stats.kills +
    stats.assists -
    stats.deaths +
    (stats.entryKills ?? 0) +
    (stats.bombPlants ?? 0) +
    (stats.bombDefuses ?? 0) +
    (stats.threeKRounds ?? 0) +
    2 * (stats.fourKRounds ?? 0) +
    3 * (stats.aces ?? 0) +
    2 * clutches;
  return total / rounds;
}

export function performanceTerm(score: number, mean: number, std: number): { z: number; performance: number } {
  const z = (score - mean) / Math.max(std, PERFORMANCE_STD_FLOOR);
  return { z, performance: clamp(Math.round(PERFORMANCE_CAP * z), -PERFORMANCE_CAP, PERFORMANCE_CAP) };
}

/** round( C × ( Result + Margin + Performance + Bonus ) ), clamped to ±45, or ±90 while calibrating. */
export function composeDelta(parts: { result: number; margin: number; performance: number; bonus: number; calibration: 1 | 2 }): number {
  const cap = parts.calibration === 2 ? DELTA_CAP_CALIBRATING : DELTA_CAP;
  const raw = Math.round(parts.calibration * (parts.result + parts.margin + parts.performance + parts.bonus));
  return clamp(raw, -cap, cap);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Population standard deviation of the lobby. */
function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function bigClutch(stats: PlayerMatchStats): boolean {
  const clutches = stats.clutchesWon ?? {};
  return (clutches[3] ?? 0) + (clutches[4] ?? 0) + (clutches[5] ?? 0) > 0;
}

export function calculateMatchExp(input: RankedMatchInput): MatchExpResult {
  const humans = input.players.filter((player) => !player.isBot);
  const totalRounds = input.roundsWon.team1 + input.roundsWon.team2;
  const winner: TeamKey | null =
    input.roundsWon.team1 === input.roundsWon.team2 ? null : input.roundsWon.team1 > input.roundsWon.team2 ? "team1" : "team2";

  const teamRating = {
    team1: mean(humans.filter((player) => player.team === "team1").map((player) => player.expBefore)),
    team2: mean(humans.filter((player) => player.team === "team2").map((player) => player.expBefore)),
  };

  const missingTelemetry = SCORE_TERMS.filter((term) => humans.length > 0 && humans.every((player) => player[term] === undefined));

  const invalidReasons: string[] = [];
  const appliesExp = input.mode !== "fun";
  if (!input.finishedNormally) invalidReasons.push("not_finished_normally");
  if (input.humanPlayersAtEnd < MIN_HUMAN_PLAYERS) invalidReasons.push("too_few_human_players");
  if (totalRounds < MIN_ROUNDS) invalidReasons.push("too_few_rounds");
  const valid = appliesExp && invalidReasons.length === 0;

  // The lobby is every human who played at least one round; bots never count.
  const lobby = humans.filter((player) => player.roundsPlayed > 0);
  const scores = new Map(lobby.map((player) => [player.userId, impactScore(player)]));
  const lobbyScores = Array.from(scores.values());
  const lobbyMean = mean(lobbyScores);
  const lobbyStd = standardDeviation(lobbyScores);
  const topScore = lobbyScores.length ? Math.max(...lobbyScores) : null;

  const players = humans.map((player): PlayerExpResult => {
    const calibration: 1 | 2 = player.rankedMatchesBefore < CALIBRATION_MATCHES ? 2 : 1;
    const outcome: PlayerExpResult["outcome"] = winner === null ? "draw" : winner === player.team ? "win" : "loss";
    const base = { result: 0, margin: 0, performance: 0, bonus: 0, calibration } satisfies ExpBreakdown;
    const settle = (delta: number, breakdown: ExpBreakdown, countsAsRankedMatch: boolean, finalOutcome = outcome): PlayerExpResult => {
      const expAfter = Math.max(0, player.expBefore + delta);
      return {
        userId: player.userId,
        steamId: player.steamId,
        team: player.team,
        expBefore: player.expBefore,
        expDelta: expAfter - player.expBefore,
        expAfter,
        rankBefore: rankForExp(player.expBefore),
        rankAfter: rankForExp(expAfter),
        proLeagueUnlocked: proLeagueAccess(Boolean(player.proLeagueUnlocked), expAfter),
        countsAsRankedMatch,
        outcome: finalOutcome,
        breakdown,
      };
    };

    if (!appliesExp) return settle(0, { ...base, rule: "fun_mode" }, false);
    // A leaver who never came back loses a fixed 25 and it counts as a loss — even in an invalid match.
    if (player.leftEarly) return settle(LEAVER_DELTA, { ...base, rule: "leaver" }, true, "loss");
    if (!valid) return settle(0, { ...base, rule: "invalid_match" }, false);
    if (totalRounds > 0 && player.roundsPlayed / totalRounds < MIN_PARTICIPATION) {
      return settle(0, { ...base, rule: "low_participation" }, false);
    }

    const s = outcome === "win" ? 1 : outcome === "draw" ? 0.5 : 0;
    const expected = expectedScore(teamRating[player.team], teamRating[otherTeam(player.team)]);
    let result = ELO_K * (s - expected);
    const shortHanded = (input.shortHandedRounds?.[player.team] ?? 0) >= SHORT_HANDED_ROUNDS;
    // Playing a man down halves a loss; it never trims a gain.
    if (shortHanded && result < 0) result /= 2;

    const margin = marginTerm(input.roundsWon[player.team], input.roundsWon[otherTeam(player.team)]);
    const score = scores.get(player.userId) ?? 0;
    const { z, performance } = performanceTerm(score, lobbyMean, lobbyStd);
    const mvp = topScore !== null && score === topScore;
    const bonus = Math.min(BONUS_CAP, ((player.aces ?? 0) > 0 || bigClutch(player) ? 1 : 0) + (mvp ? 1 : 0));

    const delta = composeDelta({ result, margin, performance, bonus, calibration });
    return settle(
      delta,
      {
        result: round2(result),
        margin: round2(margin),
        performance,
        bonus,
        calibration,
        expected: round2(expected),
        score: round2(score),
        z: round2(z),
        ...(shortHanded ? { shortHanded } : {}),
        ...(mvp ? { mvp } : {}),
      },
      true,
    );
  });

  return {
    version: RANK_CALCULATION_VERSION,
    mode: input.mode,
    appliesExp,
    valid,
    invalidReasons,
    missingTelemetry: [...missingTelemetry],
    totalRounds,
    teamRating: { team1: round2(teamRating.team1), team2: round2(teamRating.team2) },
    players,
  };
}
