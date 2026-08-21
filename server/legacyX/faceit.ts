/**
 * Server-only adapter for the FACEIT Data API. The API key is never returned
 * to the browser; callers receive only the profile fields rendered by LEGACY-X.
 */

const FACEIT_API_ORIGIN = "https://open.faceit.com/data/v4";
const CACHE_TTL_MS = 2 * 60 * 1000;

type FaceitRecord = Record<string, unknown>;
type FaceitCacheEntry = { expiresAt: number; value: FaceitProfileSnapshot };

const profileCache = new Map<string, FaceitCacheEntry>();

function apiError(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectValue(value: unknown): FaceitRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as FaceitRecord : {};
}

function faceitKey() {
  const key = process.env.FACEIT_DATA_API_KEY?.trim();
  if (!key) apiError(503, "FACEIT profile integration is not configured yet");
  return key;
}

async function faceitRequest(path: string): Promise<FaceitRecord> {
  const response = await fetch(`${FACEIT_API_ORIGIN}${path}`, {
    headers: { Authorization: `Bearer ${faceitKey()}`, Accept: "application/json" },
  });
  if (response.status === 404) apiError(404, "FACEIT player was not found");
  if (response.status === 401 || response.status === 403) apiError(503, "FACEIT profile integration is unavailable");
  if (response.status === 429) apiError(429, "FACEIT data is temporarily rate limited");
  if (!response.ok) apiError(503, "FACEIT data is temporarily unavailable");
  return objectValue(await response.json());
}

function cs2Game(player: FaceitRecord) {
  const games = objectValue(player.games);
  const game = objectValue(games.cs2 ?? games.csgo);
  if (!Object.keys(game).length) apiError(422, "This FACEIT player does not have a CS2 profile");
  return game;
}

function lifetimeValue(lifetime: FaceitRecord, ...keys: string[]) {
  for (const key of keys) {
    if (lifetime[key] != null) return lifetime[key];
  }
  return 0;
}

export type FaceitProfileSnapshot = {
  linked: true;
  playerId: string;
  nickname: string;
  avatar: string;
  country: string;
  region: string;
  elo: number;
  level: number;
  faceitUrl: string;
  stats: {
    matches: number;
    wins: number;
    winRate: number;
    averageKd: number;
    averageKills: number;
    headshots: number;
  };
  recentMatches: Array<{
    id: string;
    competition: string;
    map: string;
    status: string;
    finishedAt: string;
    faceitUrl: string;
  }>;
};

export async function resolveFaceitNickname(nickname: string) {
  const player = await faceitRequest(`/players?nickname=${encodeURIComponent(nickname)}`);
  const game = cs2Game(player);
  return {
    nickname: stringValue(player.nickname) || nickname,
    elo: numberValue(game.faceit_elo),
    level: numberValue(game.skill_level),
  };
}

export async function getFaceitProfileSnapshot(nickname: string): Promise<FaceitProfileSnapshot> {
  const cacheKey = nickname.trim().toLowerCase();
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const player = await faceitRequest(`/players?nickname=${encodeURIComponent(nickname)}`);
  return buildFaceitProfileSnapshot(player, cacheKey, nickname);
}

async function buildFaceitProfileSnapshot(player: FaceitRecord, cacheKey: string, fallbackNickname: string): Promise<FaceitProfileSnapshot> {
  const playerId = stringValue(player.player_id);
  if (!playerId) apiError(404, "FACEIT player was not found");
  const game = cs2Game(player);
  const [statistics, history] = await Promise.all([
    faceitRequest(`/players/${encodeURIComponent(playerId)}/stats/cs2`),
    faceitRequest(`/players/${encodeURIComponent(playerId)}/history?game=cs2&offset=0&limit=5`),
  ]);
  const lifetime = objectValue(statistics.lifetime);
  const historyItems = Array.isArray(history.items) ? history.items : [];
  const resolvedNickname = stringValue(player.nickname) || fallbackNickname;
  const snapshot: FaceitProfileSnapshot = {
    linked: true,
    playerId,
    nickname: resolvedNickname,
    avatar: stringValue(player.avatar),
    country: stringValue(player.country),
    region: stringValue(game.region),
    elo: numberValue(game.faceit_elo),
    level: numberValue(game.skill_level),
    faceitUrl: `https://www.faceit.com/en/players/${encodeURIComponent(resolvedNickname)}`,
    stats: {
      matches: numberValue(lifetimeValue(lifetime, "Matches", "Matches played")),
      wins: numberValue(lifetimeValue(lifetime, "Wins")),
      winRate: numberValue(lifetimeValue(lifetime, "Win Rate %", "Win Rate")),
      averageKd: numberValue(lifetimeValue(lifetime, "Average K/D Ratio", "K/D Ratio")),
      averageKills: numberValue(lifetimeValue(lifetime, "Average Kills")),
      headshots: numberValue(lifetimeValue(lifetime, "Headshots %", "Headshots")),
    },
    recentMatches: historyItems.map((entry): FaceitProfileSnapshot["recentMatches"][number] => {
      const match = objectValue(entry);
      const results = objectValue(match.results);
      return {
        id: stringValue(match.match_id),
        competition: stringValue(match.competition_name),
        map: stringValue(match.game_mode) || stringValue(match.game),
        status: stringValue(match.status),
        finishedAt: stringValue(match.finished_at),
        faceitUrl: `https://www.faceit.com/en/cs2/room/${encodeURIComponent(stringValue(match.match_id))}`,
      };
    }),
  };
  profileCache.set(cacheKey, { value: snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
  return snapshot;
}

/** Resolve a FACEIT player from the Steam game account linked to their FACEIT profile. */
export async function getFaceitProfileSnapshotForSteamId(steamId: string): Promise<FaceitProfileSnapshot> {
  const normalizedSteamId = steamId.trim();
  if (!/^\d{17}$/.test(normalizedSteamId)) apiError(404, "Steam account was not found");
  const cacheKey = `steam:${normalizedSteamId}`;
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // FACEIT has historically exposed Counter-Strike game accounts as both
  // `cs2` and `csgo`; try the modern identifier first, then the legacy one.
  for (const game of ["cs2", "csgo"]) {
    try {
      const player = await faceitRequest(`/players?game=${game}&game_player_id=${encodeURIComponent(normalizedSteamId)}`);
      return buildFaceitProfileSnapshot(player, cacheKey, normalizedSteamId);
    } catch (error) {
      const statusCode = error && typeof error === "object" && "statusCode" in error ? Number((error as { statusCode?: unknown }).statusCode) : 0;
      if (statusCode !== 404) throw error;
    }
  }
  apiError(404, "No FACEIT profile is linked to this Steam account");
}
