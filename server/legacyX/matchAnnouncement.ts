import type { AnnouncementInput } from "./announcements";

/**
 * What the Discord bot posts in its match-results channel when a match finishes: built from the final result the Match Core
 * plugin sends (`result_final`), as an announcement with the "match-result" banner. Only what the result says is used: the
 * rounds each team won, the mode, and each player's kills / deaths / assists with the site name of that Steam ID. When the score
 * is missing nothing is made up and no announcement is made.
 */

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {});
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

const MODES: Record<string, string> = { "5v5": "5v5", "5vs5": "5v5", pro: "Pro League", proleague: "Pro League", pro_league: "Pro League", fun: "Fun" };

export interface ResultPlayer {
  steamId: string;
  team: "team1" | "team2";
  kills: number;
  deaths: number;
  assists: number;
}

/** The finished match as the announcement lines; null when the result has no score. */
export function matchResultAnnouncement(result: unknown, names: ReadonlyMap<string, string>): AnnouncementInput | null {
  const r = rec(result);
  const v2 = rec(r.competitive_result);
  const hasV2 = v2.schema_version === 2;
  const team1 = count(hasV2 ? rec(v2.team1).rounds_won : r.team1_rounds);
  const team2 = count(hasV2 ? rec(v2.team2).rounds_won : r.team2_rounds);
  if (team1 === null || team2 === null) return null;

  const mode = MODES[String(hasV2 ? v2.mode : r.mode ?? "").toLowerCase()] ?? null;
  const players: ResultPlayer[] = [];
  if (hasV2 && Array.isArray(v2.players)) {
    for (const entry of v2.players) {
      const p = rec(entry);
      if (p.is_bot === true || (count(p.rounds_played) ?? 0) === 0) continue;
      if ((p.team !== "team1" && p.team !== "team2") || typeof p.steam_id !== "string") continue;
      players.push({ steamId: p.steam_id, team: p.team, kills: count(p.kills) ?? 0, deaths: count(p.deaths) ?? 0, assists: count(p.assists) ?? 0 });
    }
  }

  const verdict = team1 === team2 ? "Draw" : team1 > team2 ? "Team 1 won" : "Team 2 won";
  const lines = [`${verdict}, ${team1}–${team2}`];
  for (const team of ["team1", "team2"] as const) {
    const top = players
      .filter((p) => p.team === team)
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .slice(0, 4)
      .map((p) => `${(names.get(p.steamId) ?? p.steamId).slice(0, 20)} ${p.kills}/${p.deaths}/${p.assists}`);
    if (top.length) lines.push(`${team === "team1" ? "Team 1" : "Team 2"}: ${top.join(" · ")}`.slice(0, 200));
  }
  return { title: `${mode ? `${mode} · ` : ""}Team 1 ${team1}–${team2} Team 2`.slice(0, 80), lines, banner: "match-result" };
}

/** The Steam IDs of the players a result names, to look their site names up. */
export function resultSteamIds(result: unknown): string[] {
  const v2 = rec(rec(result).competitive_result);
  if (v2.schema_version !== 2 || !Array.isArray(v2.players)) return [];
  return v2.players.map((p) => rec(p).steam_id).filter((id): id is string => typeof id === "string").slice(0, 32);
}
