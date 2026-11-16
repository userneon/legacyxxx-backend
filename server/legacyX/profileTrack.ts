/**
 * The Profile's Track tab (owner request 2026-11-16): the detailed numbers behind a player's last ranked matches, worked out from
 * what the game plugin really reports per match (kills, deaths, assists, headshot kills, rounds, multi-kill rounds, entry kills,
 * clutches, MVPs, bomb plants and defuses). Nothing here is estimated: a figure the plugin does not send (damage per round, weapons,
 * utility) is simply not part of the answer.
 */
type Row = Record<string, unknown>;

const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const first = (value: unknown): Row => obj(Array.isArray(value) ? value[0] : value);
const round = (value: number, digits = 2): number => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};
const ratio = (a: number, b: number, digits = 2): number | null => (b > 0 ? round(a / b, digits) : null);

export const TRACK_MATCH_LIMIT = 200;
export const TRACK_FORM_LENGTH = 30;
/** Ulaanbaatar is UTC+8 all year, so the "when do you play" charts use it. */
const UB_OFFSET_MS = 8 * 3_600_000;

export interface TrackMatch {
  matchId: string;
  map: string;
  playedAt: string | null;
  result: "win" | "loss" | "draw";
  kills: number;
  deaths: number;
  assists: number;
  kd: number;
  headshotPercent: number | null;
  rounds: number;
  expDelta: number;
}

export interface TrackData {
  /** How many matches the figures cover (the newest ones, at most TRACK_MATCH_LIMIT). */
  matches: number;
  since: string | null;
  record: { wins: number; losses: number; draws: number; winRate: number | null };
  totals: { kills: number; deaths: number; assists: number; headshotKills: number; rounds: number; mvps: number; entryKills: number; clutchesWon: number; bombPlants: number; bombDefuses: number };
  rates: { kd: number | null; kda: number | null; headshotPercent: number | null; killsPerRound: number | null; deathsPerRound: number | null; assistsPerRound: number | null; killsPerMatch: number | null; deathsPerMatch: number | null; mvpPerMatch: number | null; entryKillsPerMatch: number | null; expPerMatch: number | null };
  /** The plugin reports rounds with 3, 4 and 5 kills (not 2). */
  multiKills: { rounds3k: number; rounds4k: number; rounds5k: number; per100Rounds: number | null };
  clutches: { won: number; won1v3Plus: number };
  maps: Array<{ map: string; matches: number; wins: number; winRate: number; kd: number | null; headshotPercent: number | null; killsPerMatch: number | null; exp: number }>;
  /** Newest TRACK_FORM_LENGTH matches, oldest first, so a chart reads left to right. */
  form: TrackMatch[];
  streaks: { current: { type: "win" | "loss" | null; count: number }; bestWin: number; bestLoss: number };
  best: TrackMatch | null;
  worst: TrackMatch | null;
  /** Matches played per weekday (Monday first) and per hour of the day, Ulaanbaatar time. */
  activity: { weekdays: number[]; hours: number[] };
  /** Matches the player left before the end. */
  leftEarly: number;
}

function outcomeOf(value: unknown): "win" | "loss" | "draw" {
  const text = str(value).toLowerCase();
  return text === "win" ? "win" : text === "loss" ? "loss" : "draw";
}

/** `rows` are competitive_match_exp rows (newest first) with their core_matches joined. */
export function buildTrack(rows: Row[]): TrackData {
  const used = rows.slice(0, TRACK_MATCH_LIMIT);
  const totals = { kills: 0, deaths: 0, assists: 0, headshotKills: 0, rounds: 0, mvps: 0, entryKills: 0, clutchesWon: 0, bombPlants: 0, bombDefuses: 0 };
  const multi = { rounds3k: 0, rounds4k: 0, rounds5k: 0 };
  let clutch1v3 = 0;
  let leftEarly = 0;
  let expTotal = 0;
  const record = { wins: 0, losses: 0, draws: 0 };
  const weekdays = new Array<number>(7).fill(0);
  const hours = new Array<number>(24).fill(0);
  const byMap = new Map<string, { matches: number; wins: number; kills: number; deaths: number; hs: number; exp: number }>();
  const matches: TrackMatch[] = [];

  for (const row of used) {
    const stats = obj(row.stats);
    const core = first(row.core_matches);
    const kills = num(stats.kills);
    const deaths = num(stats.deaths);
    const assists = num(stats.assists);
    const hs = num(stats.headshot_kills);
    const rounds = num(stats.rounds_played);
    const result = outcomeOf(row.outcome);
    const playedAt = str(core.finished_at) || str(row.created_at) || null;
    const expDelta = num(row.exp_delta);

    totals.kills += kills; totals.deaths += deaths; totals.assists += assists; totals.headshotKills += hs; totals.rounds += rounds;
    totals.mvps += num(stats.mvps); totals.entryKills += num(stats.entry_kills); totals.clutchesWon += num(stats.clutches_won);
    totals.bombPlants += num(stats.bomb_plants); totals.bombDefuses += num(stats.bomb_defuses);
    multi.rounds3k += num(stats.rounds_3k); multi.rounds4k += num(stats.rounds_4k); multi.rounds5k += num(stats.rounds_5k);
    clutch1v3 += num(stats.clutches_won_1v3_plus);
    if (stats.left_early === true) leftEarly += 1;
    expTotal += expDelta;
    if (result === "win") record.wins += 1; else if (result === "loss") record.losses += 1; else record.draws += 1;

    const when = playedAt ? Date.parse(playedAt) : NaN;
    if (Number.isFinite(when)) {
      const local = new Date(when + UB_OFFSET_MS);
      weekdays[(local.getUTCDay() + 6) % 7] += 1;
      hours[local.getUTCHours()] += 1;
    }

    const map = str(core.map_name);
    if (map) {
      const entry = byMap.get(map) ?? { matches: 0, wins: 0, kills: 0, deaths: 0, hs: 0, exp: 0 };
      entry.matches += 1; entry.wins += result === "win" ? 1 : 0; entry.kills += kills; entry.deaths += deaths; entry.hs += hs; entry.exp += expDelta;
      byMap.set(map, entry);
    }
    matches.push({ matchId: str(row.match_id), map, playedAt, result, kills, deaths, assists, kd: round(kills / Math.max(1, deaths)), headshotPercent: kills > 0 ? Math.round((hs / kills) * 100) : null, rounds, expDelta });
  }

  // Streaks: matches is newest first, so the run at the front is the current one.
  let bestWin = 0;
  let bestLoss = 0;
  let run = 0;
  let runType: "win" | "loss" | null = null;
  for (const match of [...matches].reverse()) {
    if (match.result === "draw") { run = 0; runType = null; continue; }
    if (match.result === runType) run += 1; else { runType = match.result; run = 1; }
    if (runType === "win") bestWin = Math.max(bestWin, run); else bestLoss = Math.max(bestLoss, run);
  }
  let current: { type: "win" | "loss" | null; count: number } = { type: null, count: 0 };
  for (const match of matches) {
    if (match.result === "draw") break;
    if (current.type === null) current = { type: match.result, count: 1 };
    else if (current.type === match.result) current.count += 1;
    else break;
  }

  const played = matches.length;
  const rated = matches.filter((match) => match.rounds > 0 || match.kills + match.deaths > 0);
  const best = rated.length ? rated.reduce((a, b) => (b.kd > a.kd || (b.kd === a.kd && b.kills > a.kills) ? b : a)) : null;
  const worst = rated.length ? rated.reduce((a, b) => (b.kd < a.kd || (b.kd === a.kd && b.kills < a.kills) ? b : a)) : null;

  return {
    matches: played,
    since: matches.length ? matches[matches.length - 1].playedAt : null,
    record: { ...record, winRate: played ? Math.round((record.wins / played) * 100) : null },
    totals,
    rates: {
      kd: ratio(totals.kills, totals.deaths),
      kda: ratio(totals.kills + totals.assists, totals.deaths),
      headshotPercent: totals.kills > 0 ? Math.round((totals.headshotKills / totals.kills) * 100) : null,
      killsPerRound: ratio(totals.kills, totals.rounds),
      deathsPerRound: ratio(totals.deaths, totals.rounds),
      assistsPerRound: ratio(totals.assists, totals.rounds),
      killsPerMatch: ratio(totals.kills, played, 1),
      deathsPerMatch: ratio(totals.deaths, played, 1),
      mvpPerMatch: ratio(totals.mvps, played),
      entryKillsPerMatch: ratio(totals.entryKills, played),
      expPerMatch: played ? round(expTotal / played, 1) : null,
    },
    multiKills: { ...multi, per100Rounds: totals.rounds > 0 ? round(((multi.rounds3k + multi.rounds4k + multi.rounds5k) / totals.rounds) * 100, 1) : null },
    clutches: { won: totals.clutchesWon, won1v3Plus: clutch1v3 },
    maps: Array.from(byMap.entries())
      .map(([map, entry]) => ({ map, matches: entry.matches, wins: entry.wins, winRate: Math.round((entry.wins / entry.matches) * 100), kd: ratio(entry.kills, entry.deaths), headshotPercent: entry.kills > 0 ? Math.round((entry.hs / entry.kills) * 100) : null, killsPerMatch: ratio(entry.kills, entry.matches, 1), exp: entry.exp }))
      .sort((a, b) => b.matches - a.matches || b.winRate - a.winRate || a.map.localeCompare(b.map)),
    form: matches.slice(0, TRACK_FORM_LENGTH).reverse(),
    streaks: { current, bestWin, bestLoss },
    best,
    worst,
    activity: { weekdays, hours },
    leftEarly,
  };
}
