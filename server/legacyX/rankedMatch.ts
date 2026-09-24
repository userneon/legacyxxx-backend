/**
 * Turns a Match Core `result_final` event into the input of the rank formula.
 *
 * Only real telemetry is used: the plugin's per-player MatchZy stats, the round score, and the
 * Match Core roster (who left and didn't come back). A stat the plugin didn't send stays
 * `undefined`, so the formula drops that term and reports it instead of guessing.
 */
import { z } from "zod";

import type { PlayerMatchStats, RankedMatchInput, RankedMode, RankedPlayerInput, TeamKey } from "./ranking";

const count = z.coerce.number().int().min(0).max(1000);

/** MatchZy player stats as the plugin serialises them (see LegacyX-MatchZy/MatchData.cs). */
const matchZyStatsSchema = z.object({
  kills: count.optional(),
  deaths: count.optional(),
  assists: count.optional(),
  headshot_kills: count.optional(),
  rounds_played: count.optional(),
  bomb_plants: count.optional(),
  bomb_defuses: count.optional(),
  "3k": count.optional(),
  "4k": count.optional(),
  "5k": count.optional(),
  "1v1": count.optional(),
  "1v2": count.optional(),
  "1v3": count.optional(),
  "1v4": count.optional(),
  "1v5": count.optional(),
  first_kills_t: count.optional(),
  first_kills_ct: count.optional(),
}).passthrough();

const matchZyPlayerSchema = z.object({
  steamid: z.string().regex(/^\d{15,20}$/).optional(),
  steam_id: z.string().regex(/^\d{15,20}$/).optional(),
  name: z.string().max(128).optional(),
  is_bot: z.boolean().optional(),
  stats: matchZyStatsSchema.default({}),
}).passthrough();

const teamSchema = z.object({
  score: count.optional(),
  rounds: count.optional(),
  players: z.array(matchZyPlayerSchema).max(16).default([]),
}).passthrough();

/**
 * `competitive_result` v2, what LegacyX-MatchZy/LegacyXRankTelemetry.cs sends on `result_final`
 * (docs/PLUGIN_RANKED_TELEMETRY_V2.md). Counters listed in `unavailable_fields` are treated as "not sent".
 */
const nullableCount = count.nullable().optional();
const v2PlayerSchema = z.object({
  steam_id: z.string().regex(/^\d{15,20}$/),
  team: z.enum(["team1", "team2"]),
  is_bot: z.boolean().optional(),
  fill: z.boolean().optional(),
  rounds_played: count,
  kills: nullableCount,
  deaths: nullableCount,
  assists: nullableCount,
  headshot_kills: nullableCount,
  entry_kills: nullableCount,
  bomb_plants: nullableCount,
  bomb_defuses: nullableCount,
  rounds_3k: nullableCount,
  rounds_4k: nullableCount,
  rounds_5k: nullableCount,
  clutches_won: nullableCount,
  clutches_won_1v3_plus: nullableCount,
  mvps: nullableCount,
  left_early: z.boolean(),
  left_at_round: count.nullable().optional(),
}).passthrough();
type V2Player = z.infer<typeof v2PlayerSchema>;

export const competitiveResultV2Schema = z.object({
  schema_version: z.literal(2),
  mode: z.enum(["5v5", "pro_league", "fun"]),
  finished_normally: z.boolean(),
  human_players_at_end: count,
  total_rounds: count,
  team1: z.object({ rounds_won: count, short_handed_rounds: count.optional() }).passthrough(),
  team2: z.object({ rounds_won: count, short_handed_rounds: count.optional() }).passthrough(),
  unavailable_fields: z.array(z.string().max(64)).max(32).default([]),
  players: z.array(v2PlayerSchema).max(32),
}).passthrough()
  .refine((value) => new Set(value.players.map((player) => player.steam_id)).size === value.players.length, "duplicate steam_id")
  .refine((value) => value.players.every((player) => player.rounds_played <= value.total_rounds), "rounds_played above total_rounds")
  .refine((value) => value.team1.rounds_won + value.team2.rounds_won <= value.total_rounds, "round wins above total_rounds");

export type CompetitiveResultV2 = z.infer<typeof competitiveResultV2Schema>;

export const rankedResultSchema = z.object({
  winner_team: z.enum(["team1", "team2", "none"]).optional(),
  mode: z.enum(["5v5", "5vs5", "pro", "proleague", "fun"]).optional(),
  team1_rounds: count.optional(),
  team2_rounds: count.optional(),
  finished_normally: z.boolean().optional(),
  human_players_at_end: count.optional(),
  rank_result: z.object({
    team1: teamSchema,
    team2: teamSchema,
  }).passthrough().nullable().optional(),
  /** v2 telemetry (current plugins); preferred over the older `rank_result` when present. */
  competitive_result: z.unknown().optional(),
}).passthrough();

export type RankedResultPayload = z.infer<typeof rankedResultSchema>;

export interface MatchParticipant {
  user_id: string;
  steam_id: string;
  team_key: string;
  connected: boolean | null;
  disconnected_at: string | null;
  returned_at: string | null;
  reconnect_deadline: string | null;
}

export interface PlayerProgression {
  user_id: string;
  current_exp: number;
  matches_completed: number;
  pro_league_unlocked: boolean;
}

export interface BuiltRankedInput {
  input: RankedMatchInput;
  /** Why the result can't be ranked at all (then nothing is applied). */
  unrankable: string[];
  /** Per-player totals plus the plugin's full stat line, kept on the snapshot row for match details. */
  stats: Map<string, { kills: number; deaths: number; assists: number; headshot_kills: number; rounds_played: number; raw: Record<string, unknown> }>;
}

const steamIdOf = (player: z.infer<typeof matchZyPlayerSchema>) => player.steamid ?? player.steam_id ?? "";

function toStats(raw: z.infer<typeof matchZyStatsSchema>): PlayerMatchStats {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
  const firstKills = has("first_kills_t") || has("first_kills_ct") ? (raw.first_kills_t ?? 0) + (raw.first_kills_ct ?? 0) : undefined;
  const clutchKeys = ["1v1", "1v2", "1v3", "1v4", "1v5"] as const;
  const clutchesWon = clutchKeys.some(has)
    ? { 1: raw["1v1"] ?? 0, 2: raw["1v2"] ?? 0, 3: raw["1v3"] ?? 0, 4: raw["1v4"] ?? 0, 5: raw["1v5"] ?? 0 }
    : undefined;
  return {
    roundsPlayed: raw.rounds_played ?? 0,
    kills: raw.kills ?? 0,
    deaths: raw.deaths ?? 0,
    assists: raw.assists ?? 0,
    entryKills: firstKills,
    bombPlants: raw.bomb_plants,
    bombDefuses: raw.bomb_defuses,
    threeKRounds: raw["3k"],
    fourKRounds: raw["4k"],
    aces: raw["5k"],
    clutchesWon,
  };
}

function normaliseMode(mode: RankedResultPayload["mode"]): RankedMode {
  if (mode === "fun") return "fun";
  if (mode === "pro" || mode === "proleague") return "pro";
  return "5v5";
}

/** A participant who dropped and never came back before the rejoin window closed. */
export function isLeaver(participant: MatchParticipant, finishedAt: Date): boolean {
  if (!participant.disconnected_at || participant.returned_at) return false;
  if (participant.connected) return false;
  const deadline = participant.reconnect_deadline ? Date.parse(participant.reconnect_deadline) : Number.NaN;
  return !Number.isFinite(deadline) || deadline <= finishedAt.getTime();
}

/** Rank input from `competitive_result` v2. Match Core's roster decides who is a registered player. */
export function buildRankedInputV2(
  telemetry: CompetitiveResultV2,
  participants: MatchParticipant[],
  progression: PlayerProgression[],
): BuiltRankedInput {
  const unavailable = new Set(telemetry.unavailable_fields);
  const counter = (player: V2Player | undefined, key: keyof V2Player) => {
    if (!player || unavailable.has(String(key))) return undefined;
    const value = player[key];
    return typeof value === "number" ? value : undefined;
  };
  const bySteamId = new Map(telemetry.players.map((player) => [player.steam_id, player]));
  const progressionByUser = new Map(progression.map((row) => [row.user_id, row]));
  const shortHandedRounds: Record<TeamKey, number> = {
    team1: telemetry.team1.short_handed_rounds ?? 0,
    team2: telemetry.team2.short_handed_rounds ?? 0,
  };
  // The plugin leaves short_handed_rounds out and reports left_at_round instead.
  const deriveShortHanded = telemetry.team1.short_handed_rounds === undefined && telemetry.team2.short_handed_rounds === undefined;
  const players: RankedPlayerInput[] = [];
  const stats: BuiltRankedInput["stats"] = new Map();
  const unrankable: string[] = [];

  for (const participant of participants) {
    const team: TeamKey = participant.team_key === "team2" ? "team2" : "team1";
    const reported = bySteamId.get(participant.steam_id);
    if (!reported) unrankable.push(`missing_player:${participant.steam_id}`);
    const kills = counter(reported, "kills");
    const deaths = counter(reported, "deaths");
    const assists = counter(reported, "assists");
    const clutchesAll = counter(reported, "clutches_won");
    const clutchesBig = counter(reported, "clutches_won_1v3_plus");
    const leftEarly = reported?.left_early === true;
    if (leftEarly && deriveShortHanded) {
      const leftAt = reported?.left_at_round ?? reported?.rounds_played ?? 0;
      shortHandedRounds[team] = Math.max(shortHandedRounds[team], Math.max(0, telemetry.total_rounds - leftAt));
    }
    const current = progressionByUser.get(participant.user_id);
    players.push({
      userId: participant.user_id,
      steamId: participant.steam_id,
      team,
      isBot: reported?.is_bot === true,
      roundsPlayed: reported?.rounds_played ?? 0,
      kills: kills ?? 0,
      deaths: deaths ?? 0,
      assists: assists ?? 0,
      entryKills: counter(reported, "entry_kills"),
      bombPlants: counter(reported, "bomb_plants"),
      bombDefuses: counter(reported, "bomb_defuses"),
      threeKRounds: counter(reported, "rounds_3k"),
      fourKRounds: counter(reported, "rounds_4k"),
      aces: counter(reported, "rounds_5k"),
      // v2 reports clutch totals, not per opponent count: 1v3+ go to the "big clutch" bucket.
      clutchesWon: clutchesAll === undefined && clutchesBig === undefined ? undefined : { 1: Math.max(0, (clutchesAll ?? 0) - (clutchesBig ?? 0)), 3: clutchesBig ?? 0 },
      expBefore: current?.current_exp ?? 1000,
      rankedMatchesBefore: current?.matches_completed ?? 0,
      proLeagueUnlocked: current?.pro_league_unlocked ?? false,
      leftEarly,
    });
    stats.set(participant.user_id, {
      kills: kills ?? 0,
      deaths: deaths ?? 0,
      assists: assists ?? 0,
      headshot_kills: counter(reported, "headshot_kills") ?? 0,
      rounds_played: reported?.rounds_played ?? 0,
      raw: reported ? { ...reported } : {},
    });
  }

  return {
    unrankable,
    stats,
    input: {
      mode: telemetry.mode === "fun" ? "fun" : telemetry.mode === "pro_league" ? "pro" : "5v5",
      finishedNormally: telemetry.finished_normally,
      roundsWon: { team1: telemetry.team1.rounds_won, team2: telemetry.team2.rounds_won },
      humanPlayersAtEnd: telemetry.human_players_at_end,
      shortHandedRounds,
      players,
    },
  };
}

export function buildRankedInput(
  result: RankedResultPayload,
  participants: MatchParticipant[],
  progression: PlayerProgression[],
  finishedAt: Date,
): BuiltRankedInput {
  if (result.competitive_result !== undefined && result.competitive_result !== null) {
    const telemetry = competitiveResultV2Schema.safeParse(result.competitive_result);
    if (!telemetry.success) {
      return { unrankable: ["invalid_competitive_result"], stats: new Map(), input: { mode: "5v5", finishedNormally: false, roundsWon: { team1: 0, team2: 0 }, humanPlayersAtEnd: 0, players: [] } };
    }
    return buildRankedInputV2(telemetry.data, participants, progression);
  }
  const unrankable: string[] = [];
  const rank = result.rank_result;
  const team1Rounds = result.team1_rounds ?? rank?.team1.rounds;
  const team2Rounds = result.team2_rounds ?? rank?.team2.rounds;
  if (!rank) unrankable.push("missing_player_stats");
  if (team1Rounds === undefined || team2Rounds === undefined) unrankable.push("missing_round_score");

  const byStatsSteamId = new Map<string, { team: TeamKey; player: z.infer<typeof matchZyPlayerSchema> }>();
  for (const team of ["team1", "team2"] as const) {
    for (const player of rank?.[team].players ?? []) {
      const steamId = steamIdOf(player);
      if (steamId) byStatsSteamId.set(steamId, { team, player });
    }
  }
  const progressionByUser = new Map(progression.map((row) => [row.user_id, row]));
  const players: RankedPlayerInput[] = [];
  const stats: BuiltRankedInput["stats"] = new Map();
  const shortHandedRounds: Record<TeamKey, number> = { team1: 0, team2: 0 };
  const totalRounds = (team1Rounds ?? 0) + (team2Rounds ?? 0);

  // Match Core's roster is the source of truth for who is a registered player on which team.
  for (const participant of participants) {
    const team = participant.team_key === "team2" ? "team2" : "team1";
    const reported = byStatsSteamId.get(participant.steam_id);
    const raw = reported?.player.stats ?? {};
    const playerStats = toStats(matchZyStatsSchema.parse(raw));
    const leftEarly = isLeaver(participant, finishedAt);
    if (leftEarly) shortHandedRounds[team] = Math.max(shortHandedRounds[team], Math.max(0, totalRounds - playerStats.roundsPlayed));
    const current = progressionByUser.get(participant.user_id);
    players.push({
      ...playerStats,
      userId: participant.user_id,
      steamId: participant.steam_id,
      team,
      isBot: reported?.player.is_bot === true,
      expBefore: current?.current_exp ?? 1000,
      rankedMatchesBefore: current?.matches_completed ?? 0,
      proLeagueUnlocked: current?.pro_league_unlocked ?? false,
      leftEarly,
    });
    stats.set(participant.user_id, {
      kills: playerStats.kills,
      deaths: playerStats.deaths,
      assists: playerStats.assists,
      headshot_kills: matchZyStatsSchema.parse(raw).headshot_kills ?? 0,
      rounds_played: playerStats.roundsPlayed,
      raw: { ...raw },
    });
  }

  const humanPlayersAtEnd = result.human_players_at_end
    ?? participants.filter((participant) => participant.connected !== false && !isLeaver(participant, finishedAt)).length;

  return {
    unrankable,
    stats,
    input: {
      mode: normaliseMode(result.mode),
      finishedNormally: result.finished_normally ?? true,
      roundsWon: { team1: team1Rounds ?? 0, team2: team2Rounds ?? 0 },
      humanPlayersAtEnd,
      shortHandedRounds,
      players,
    },
  };
}
