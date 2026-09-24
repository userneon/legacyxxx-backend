/**
 * Play pages: server cards and the Quick join pick, built from plugin heartbeats
 * (legacy_x.reconnect_servers) and live match snapshots (legacy_x.server_live_match_snapshots).
 * Pure functions only; routes.ts loads the rows.
 */

type Row = Record<string, any>;

export type PlayMode = "5x5" | "fun" | "pro";
export type PlayServerStatus = "waiting" | "warmup" | "live" | "full" | "offline";

export interface PlayServer {
  id: string;
  name: string;
  map: string;
  mode: PlayMode;
  /** The raw LEGACYX_SERVER_MODE value (Fun servers use it for their mode chips). */
  modeLabel: string;
  players: number;
  maxPlayers: number;
  status: PlayServerStatus;
  round: number | null;
  score: { t: number; ct: number } | null;
  connectAddress: string | null;
  gotvAddress: string | null;
  joinable: boolean;
}

/** Heartbeats older than this mean the server is gone. */
export const HEARTBEAT_STALE_MS = 90_000;

/** LEGACYX_SERVER_MODE → page. competitive_5v5 is the plugin default. */
export function playModeFromServerMode(value: unknown): PlayMode | null {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!mode) return null;
  if (mode === "proleague" || mode === "pro" || mode === "pro_league" || mode.startsWith("proleague")) return "pro";
  if (mode === "fun" || mode.startsWith("fun")) return "fun";
  if (mode === "competitive_5v5" || mode === "5v5" || mode === "5vs5" || mode === "5x5" || mode.startsWith("competitive")) return "5x5";
  return null;
}

const DEFAULT_MAX_PLAYERS: Record<PlayMode, number> = { "5x5": 10, pro: 10, fun: 10 };

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function mapPlayServer(server: Row, snapshot: Row | null, now = Date.now()): PlayServer | null {
  const mode = playModeFromServerMode(server.current_mode);
  if (!mode) return null;
  const heartbeat = Date.parse(String(server.last_heartbeat_at ?? ""));
  const online = Number.isFinite(heartbeat) && now - heartbeat <= HEARTBEAT_STALE_MS;
  const players = Math.max(0, number(server.player_count) ?? 0);
  const maxPlayers = Math.max(1, number(server.max_players) ?? DEFAULT_MAX_PLAYERS[mode]);
  const reported = Date.parse(String(snapshot?.reported_at ?? ""));
  const freshSnapshot = snapshot && Number.isFinite(reported) && now - reported <= HEARTBEAT_STALE_MS ? snapshot : null;
  const state = typeof freshSnapshot?.state === "string" ? freshSnapshot.state : "waiting";
  const live = state === "live" || state === "paused";
  const scoreT = number(freshSnapshot?.score_t);
  const scoreCt = number(freshSnapshot?.score_ct);

  let status: PlayServerStatus;
  if (!online) status = "offline";
  else if (players >= maxPlayers) status = "full";
  else if (live) status = "live";
  else status = players > 0 ? "warmup" : "waiting";

  const connectAddress = typeof server.connect_address === "string" && server.connect_address.trim() ? server.connect_address.trim() : null;
  return {
    id: String(server.server_id),
    name: String(server.display_name || server.server_id),
    map: String(freshSnapshot?.map_name || server.current_map || "Unknown"),
    mode,
    modeLabel: String(server.current_mode ?? ""),
    players,
    maxPlayers,
    status,
    round: live ? number(freshSnapshot?.round_number) : null,
    score: live && scoreT !== null && scoreCt !== null ? { t: scoreT, ct: scoreCt } : null,
    connectAddress,
    gotvAddress: typeof server.gotv_address === "string" && server.gotv_address.trim() ? server.gotv_address.trim() : null,
    joinable: online && players < maxPlayers && Boolean(connectAddress),
  };
}

/** Default order: joinable first, then most players, then name. */
export function sortPlayServers(servers: PlayServer[]) {
  return [...servers].sort((a, b) => Number(b.joinable) - Number(a.joinable) || b.players - a.players || a.name.localeCompare(b.name));
}

/**
 * Quick join.
 * - 5x5 / Pro: joinable servers that have not started yet (waiting / warmup); the fullest one
 *   (closest to starting), ties broken by the viewer's favourite maps.
 * - Fun: the busiest server with a free slot (live rounds are fine on Fun).
 */
export function pickQuickJoin(servers: PlayServer[], mode: PlayMode, favouriteMaps: string[] = []): PlayServer | null {
  const favourites = new Set(favouriteMaps.map((map) => map.trim().toLowerCase()).filter(Boolean));
  const candidates = servers.filter((server) => server.mode === mode && server.joinable && (mode === "fun" || server.status === "waiting" || server.status === "warmup"));
  candidates.sort((a, b) =>
    b.players - a.players
    || Number(favourites.has(b.map.toLowerCase())) - Number(favourites.has(a.map.toLowerCase()))
    || a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}
