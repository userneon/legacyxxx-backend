/**
 * Match Core `result_final` → competitive EXP.
 *
 * The plugin reports raw telemetry only (`result.competitive_result`, schema v2, see docs/PLUGIN_RANKED_TELEMETRY_V2.md).
 * The API reads each player's EXP and ranked-match count from the database, calculates every delta with the pure
 * rank module, and hands the whole match to legacy_x.apply_competitive_match_exp, which applies it atomically and
 * idempotently (receipt by event id). Client-sent EXP or rank is never read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CALCULATION_VERSION, OPTIONAL_COUNTERS, calculateMatchExp, isRankedMode, type MatchExpResult, type MatchInput, type OptionalCounter, type TeamKey } from "./exp";
import { STARTING_EXP } from "./ranks";

const steamIdSchema = z.string().regex(/^\d{15,20}$/);
const counter = (max: number) => z.coerce.number().int().min(0).max(max).nullable().optional();
const teamKeySchema = z.enum(["team1", "team2"]);

/** Plugin field names for the optional score counters. */
export const PLUGIN_COUNTER_FIELDS: Record<OptionalCounter, string> = {
  entryKills: "entry_kills",
  bombPlants: "bomb_plants",
  bombDefuses: "bomb_defuses",
  threeKRounds: "rounds_3k",
  fourKRounds: "rounds_4k",
  aces: "rounds_5k",
  clutchesWon: "clutches_won",
  clutchesWon1v3Plus: "clutches_won_1v3_plus",
};

export const competitivePlayerSchema = z.object({
  steam_id: steamIdSchema,
  team: teamKeySchema,
  is_bot: z.boolean().optional().default(false),
  /** Joined mid-match as a fill (not in the team when the match started). */
  fill: z.boolean().optional().default(false),
  rounds_played: z.coerce.number().int().min(0).max(120),
  kills: z.coerce.number().int().min(0).max(300),
  deaths: z.coerce.number().int().min(0).max(300),
  assists: z.coerce.number().int().min(0).max(300),
  headshot_kills: z.coerce.number().int().min(0).max(300).optional().default(0),
  entry_kills: counter(120),
  bomb_plants: counter(120),
  bomb_defuses: counter(120),
  rounds_3k: counter(120),
  rounds_4k: counter(120),
  rounds_5k: counter(120),
  clutches_won: counter(120),
  clutches_won_1v3_plus: counter(120),
  mvps: counter(120),
  left_early: z.boolean().optional().default(false),
  left_at_round: z.coerce.number().int().min(0).max(120).nullable().optional(),
}).passthrough();

export const competitiveResultV2Schema = z.object({
  schema_version: z.literal(2),
  mode: z.enum(["5v5", "pro_league", "fun"]),
  finished_normally: z.boolean(),
  human_players_at_end: z.coerce.number().int().min(0).max(64),
  total_rounds: z.coerce.number().int().min(0).max(120),
  team1: z.object({ rounds_won: z.coerce.number().int().min(0).max(120), short_handed_rounds: z.coerce.number().int().min(0).max(120).optional() }),
  team2: z.object({ rounds_won: z.coerce.number().int().min(0).max(120), short_handed_rounds: z.coerce.number().int().min(0).max(120).optional() }),
  players: z.array(competitivePlayerSchema).min(1).max(64),
  /** Counters the plugin cannot collect yet (plugin field names). */
  unavailable_fields: z.array(z.string().max(64)).max(32).optional().default([]),
}).superRefine((input, context) => {
  const seen = new Set<string>();
  input.players.forEach((entry, index) => {
    if (seen.has(entry.steam_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["players", index, "steam_id"], message: "Duplicate SteamID in competitive result" });
    seen.add(entry.steam_id);
    if (entry.rounds_played > input.total_rounds) context.addIssue({ code: z.ZodIssueCode.custom, path: ["players", index, "rounds_played"], message: "rounds_played exceeds total_rounds" });
  });
  if (input.team1.rounds_won + input.team2.rounds_won > input.total_rounds) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["total_rounds"], message: "Round wins exceed total_rounds" });
  }
});
export type CompetitiveResultV2 = z.infer<typeof competitiveResultV2Schema>;

export interface PlayerStanding {
  userId: string;
  expBefore: number;
  rankedMatchesBefore: number;
}

/** Rounds a team spent short-handed: the plugin's count, or from leavers' `left_at_round` when no fill joined that team. */
function shortHandedRounds(result: CompetitiveResultV2, team: TeamKey): number {
  const reported = result[team].short_handed_rounds;
  if (reported !== undefined) return reported;
  const onTeam = result.players.filter(entry => entry.team === team && !entry.is_bot);
  if (onTeam.some(entry => entry.fill)) return 0;
  const leftAt = onTeam.filter(entry => entry.left_early && entry.left_at_round != null).map(entry => entry.left_at_round!);
  return leftAt.length === 0 ? 0 : Math.max(0, result.total_rounds - Math.min(...leftAt));
}

export function toMatchInput(result: CompetitiveResultV2, standings: ReadonlyMap<string, PlayerStanding>): MatchInput {
  const unavailable = OPTIONAL_COUNTERS.filter(name => result.unavailable_fields.includes(PLUGIN_COUNTER_FIELDS[name]));
  return {
    mode: result.mode,
    finishedNormally: result.finished_normally,
    humanPlayersAtEnd: result.human_players_at_end,
    totalRounds: result.total_rounds,
    roundsWon: { team1: result.team1.rounds_won, team2: result.team2.rounds_won },
    shortHandedRounds: { team1: shortHandedRounds(result, "team1"), team2: shortHandedRounds(result, "team2") },
    unavailableCounters: unavailable,
    players: result.players.map(entry => {
      const standing = standings.get(entry.steam_id);
      return {
        steamId: entry.steam_id,
        userId: standing?.userId ?? null,
        team: entry.team,
        isBot: entry.is_bot,
        expBefore: standing?.expBefore ?? STARTING_EXP,
        rankedMatchesBefore: standing?.rankedMatchesBefore ?? 0,
        startedMatch: !entry.fill,
        roundsPlayed: entry.rounds_played,
        kills: entry.kills,
        deaths: entry.deaths,
        assists: entry.assists,
        entryKills: entry.entry_kills,
        bombPlants: entry.bomb_plants,
        bombDefuses: entry.bomb_defuses,
        threeKRounds: entry.rounds_3k,
        fourKRounds: entry.rounds_4k,
        aces: entry.rounds_5k,
        clutchesWon: entry.clutches_won,
        clutchesWon1v3Plus: entry.clutches_won_1v3_plus,
        leftEarly: entry.left_early,
      };
    }),
  };
}

/** Rows for legacy_x.apply_competitive_match_exp: registered players only (the table references users). */
export function toApplyPlayers(result: CompetitiveResultV2, calculation: MatchExpResult) {
  const raw = new Map(result.players.map(entry => [entry.steam_id, entry]));
  return calculation.players.filter(entry => entry.userId !== null).map(entry => {
    const source = raw.get(entry.steamId)!;
    return {
      user_id: entry.userId,
      team_key: entry.team,
      outcome: entry.outcome,
      exp_before: entry.expBefore,
      exp_delta: entry.expDelta,
      counts_as_ranked: entry.countsAsRanked,
      exp_breakdown: entry.breakdown,
      kills: source.kills,
      deaths: source.deaths,
      assists: source.assists,
      headshot_kills: source.headshot_kills,
      stats: {
        rounds_played: source.rounds_played,
        kills: source.kills,
        deaths: source.deaths,
        assists: source.assists,
        headshot_kills: source.headshot_kills,
        entry_kills: source.entry_kills ?? null,
        bomb_plants: source.bomb_plants ?? null,
        bomb_defuses: source.bomb_defuses ?? null,
        rounds_3k: source.rounds_3k ?? null,
        rounds_4k: source.rounds_4k ?? null,
        rounds_5k: source.rounds_5k ?? null,
        clutches_won: source.clutches_won ?? null,
        clutches_won_1v3_plus: source.clutches_won_1v3_plus ?? null,
        mvps: source.mvps ?? null,
        fill: source.fill,
        left_early: source.left_early,
        left_at_round: source.left_at_round ?? null,
      },
    };
  });
}

export type CompetitiveOutcome =
  | { status: "skipped"; reason: "competitive_result_missing" | "unranked_mode"; missing?: string[] }
  | { status: "processed" | "duplicate"; eventId: string; valid: boolean; invalidReasons: string[]; omittedTerms: string[]; players: number };

type Db = SupabaseClient<any, any, any, any, any>;

async function loadStandings(db: Db, steamIds: string[]) {
  const standings = new Map<string, PlayerStanding>();
  if (steamIds.length === 0) return standings;
  const users = await db.from("users").select("id,steam_id").in("steam_id", steamIds);
  if (users.error) throw Object.assign(new Error("Unable to resolve match players"), { statusCode: 500 });
  const rows = (users.data ?? []) as Array<{ id: string; steam_id: string }>;
  const progression = rows.length === 0
    ? { data: [], error: null }
    : await db.from("competitive_player_progression").select("user_id,current_exp,matches_completed").in("user_id", rows.map(row => row.id));
  if (progression.error) throw Object.assign(new Error("Unable to read player progression"), { statusCode: 500 });
  const byUser = new Map(((progression.data ?? []) as Array<{ user_id: string; current_exp: number; matches_completed: number }>).map(row => [row.user_id, row]));
  for (const row of rows) {
    const current = byUser.get(row.id);
    standings.set(row.steam_id, { userId: row.id, expBefore: current?.current_exp ?? STARTING_EXP, rankedMatchesBefore: current?.matches_completed ?? 0 });
  }
  return standings;
}

/**
 * Calculate and apply EXP for one finished Match Core match. `payload` is the full `result_final` event body.
 * A concurrent EXP change for a player (SQLSTATE 40001 from the apply function) is retried once with fresh values.
 */
export async function applyCompetitiveResult(db: Db, input: { pluginId: string; eventId: string; matchId: string; payload: Record<string, unknown> }): Promise<CompetitiveOutcome> {
  const raw = (input.payload.result as Record<string, unknown> | undefined)?.competitive_result;
  if (raw === undefined || raw === null) {
    return { status: "skipped", reason: "competitive_result_missing", missing: ["result.competitive_result (schema_version 2)"] };
  }
  const result = competitiveResultV2Schema.parse(raw);
  if (!isRankedMode(result.mode)) return { status: "skipped", reason: "unranked_mode" };

  const humans = result.players.filter(entry => !entry.is_bot).map(entry => entry.steam_id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const standings = await loadStandings(db, humans);
    const calculation = calculateMatchExp(toMatchInput(result, standings));
    const players = toApplyPlayers(result, calculation);
    const summary = { valid: calculation.valid, invalid_reasons: calculation.invalidReasons, omitted_terms: calculation.omittedTerms, lobby: calculation.lobby, mode: result.mode, total_rounds: result.total_rounds };
    const applied = await db.schema("legacy_x").rpc("apply_competitive_match_exp", {
      p_plugin_id: input.pluginId,
      p_event_id: input.eventId,
      p_match_id: input.matchId,
      p_calculation_version: CALCULATION_VERSION,
      p_summary: summary,
      p_players: players,
    });
    if (applied.error?.code === "40001" && attempt === 0) continue;
    if (applied.error) {
      const status = applied.error.code === "22023" ? 400 : applied.error.code === "40001" ? 409 : 500;
      throw Object.assign(new Error(status === 400 ? "The competitive result was rejected" : status === 409 ? "Player EXP changed during the calculation" : "Unable to apply competitive EXP"), { statusCode: status });
    }
    const response = (applied.data ?? {}) as { status?: string };
    return {
      status: response.status === "duplicate" ? "duplicate" : "processed",
      eventId: input.eventId,
      valid: calculation.valid,
      invalidReasons: calculation.invalidReasons,
      omittedTerms: calculation.omittedTerms.map(name => PLUGIN_COUNTER_FIELDS[name]),
      players: players.length,
    };
  }
  throw Object.assign(new Error("Player EXP changed during the calculation"), { statusCode: 409 });
}
