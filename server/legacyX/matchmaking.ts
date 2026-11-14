/**
 * Matchmaking (owner decision 2026-11-14: "close the community servers, go to a queue, real fights"). Pure functions only; routes.ts loads the rows and
 * runs them. A queue entry is a player waiting for a 5v5; a lobby is ten of them close in EXP; a match is a lobby that accepted and got a server.
 *
 * - The lobby is built round the player who has waited longest: players within a window of that player's EXP, the window widening the longer they wait.
 * - The ten are split into two teams by a snake draft on EXP so the teams are even.
 * - The match is handed to a game server as a MatchZy match file (`matchzy_loadmatch`), which also lets only those ten into the teams.
 */
import type { PlayServer } from "./play";

export type QueueMode = "5x5" | "pro";

export interface QueueEntry {
  userId: string;
  steamId: string;
  username: string;
  exp: number;
  joinedAt: number;
}

export interface LobbyPlayer extends QueueEntry {
  team: 1 | 2;
}

/** Players needed for one match. */
export const MATCH_SIZE = 10;
/** Seconds the ten have to press Accept. */
export const ACCEPT_SECONDS = 30;
/** How far apart in EXP a lobby may start, and how much the window grows per second of waiting for the longest-waiting player. */
export const BASE_EXP_WINDOW = 200;
export const WINDOW_PER_SECOND = 8;
export const MAX_EXP_WINDOW = 3000;

/** The maps a queued match is played on. */
export const MAP_POOL = ["de_mirage", "de_inferno", "de_dust2", "de_ancient", "de_nuke", "de_anubis", "de_overpass", "de_vertigo"] as const;

export const expWindow = (waitedSeconds: number) => Math.min(MAX_EXP_WINDOW, BASE_EXP_WINDOW + Math.max(0, waitedSeconds) * WINDOW_PER_SECOND);

/**
 * Ten players for one match, or null when the queue cannot make one yet. The anchor is the longest-waiting player; the other nine are the nearest in EXP
 * among those inside the anchor's window (the window of the anchor's wait), ties broken by who waited longer.
 */
export function pickLobby(queue: readonly QueueEntry[], now: number): QueueEntry[] | null {
  if (queue.length < MATCH_SIZE) return null;
  const byWait = [...queue].sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
  const anchor = byWait[0];
  const window = expWindow((now - anchor.joinedAt) / 1000);
  const others = byWait.slice(1)
    .filter((entry) => Math.abs(entry.exp - anchor.exp) <= window)
    .sort((a, b) => Math.abs(a.exp - anchor.exp) - Math.abs(b.exp - anchor.exp) || a.joinedAt - b.joinedAt);
  if (others.length < MATCH_SIZE - 1) return null;
  return [anchor, ...others.slice(0, MATCH_SIZE - 1)];
}

/** Two even teams of five: best, then the next two worst... a snake draft on EXP (A B B A A B B A A B). */
export function splitTeams(players: readonly QueueEntry[]): LobbyPlayer[] {
  const order = [...players].sort((a, b) => b.exp - a.exp || a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
  const pattern: Array<1 | 2> = [1, 2, 2, 1, 1, 2, 2, 1, 1, 2];
  return order.map((player, index) => ({ ...player, team: pattern[index % pattern.length] }));
}

/** A map for the match: random from the pool, never the one the last match on that server used when there is a choice. */
export function pickMap(random: () => number = Math.random, avoid?: string | null): string {
  const pool = MAP_POOL.filter((map) => map !== avoid);
  const list = pool.length > 0 ? pool : MAP_POOL;
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

/** A server that can take a queued match now: online, empty, not mid-match and not already promised to one. */
export function pickServerForMatch(servers: readonly PlayServer[], mode: QueueMode, busyServerIds: ReadonlySet<string>): PlayServer | null {
  const candidates = servers.filter((server) => server.mode === mode && server.joinable && server.players === 0 && (server.status === "waiting") && !busyServerIds.has(server.id));
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}

export interface MatchZyConfig {
  matchid: string;
  num_maps: 1;
  players_per_team: 5;
  min_players_to_ready: 5;
  maplist: string[];
  team1: { name: string; players: Record<string, string> };
  team2: { name: string; players: Record<string, string> };
  cvars: Record<string, string>;
}

const cleanName = (name: string) => name.replace(/["\\\r\n\t]/g, "").trim().slice(0, 32) || "Player";

/** The MatchZy (get5-format) match file for a lobby: both teams by SteamID64, one map, five a side. */
export function buildMatchZyConfig(matchId: string, map: string, players: readonly LobbyPlayer[]): MatchZyConfig {
  const team = (side: 1 | 2) => Object.fromEntries(players.filter((player) => player.team === side).map((player) => [player.steamId, cleanName(player.username)]));
  return {
    matchid: matchId,
    num_maps: 1,
    players_per_team: 5,
    min_players_to_ready: 5,
    maplist: [map],
    team1: { name: "Team 1", players: team(1) },
    team2: { name: "Team 2", players: team(2) },
    cvars: { hostname: "LEGACY-X Match" },
  };
}
