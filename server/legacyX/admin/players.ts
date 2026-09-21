import { legacyXDb, legacyXError } from "../supabase";

type DbRow = Record<string, any>;
const db = () => legacyXDb();

export type PlayerCard = { steamId: string; userId: string | null; name: string; avatar: string };

/** Site profile where one exists, otherwise the most recent in-game name. */
export async function playerCards(steamIds: string[]): Promise<Map<string, PlayerCard>> {
  const ids = [...new Set(steamIds.filter(Boolean))];
  const cards = new Map<string, PlayerCard>();
  if (ids.length === 0) return cards;
  const [users, names] = await Promise.all([
    db().from("users").select("id,steam_id,username,avatar").in("steam_id", ids),
    db().from("player_name_history").select("steam_id,name,last_seen_at").in("steam_id", ids).order("last_seen_at", { ascending: false }),
  ]);
  legacyXError(users.error || names.error, "Unable to resolve players");
  for (const row of (names.data ?? []) as DbRow[]) {
    if (!cards.has(row.steam_id)) cards.set(row.steam_id, { steamId: row.steam_id, userId: null, name: row.name, avatar: "" });
  }
  for (const row of (users.data ?? []) as DbRow[]) {
    cards.set(row.steam_id, { steamId: row.steam_id, userId: row.id, name: row.username || cards.get(row.steam_id)?.name || row.steam_id, avatar: row.avatar ?? "" });
  }
  for (const id of ids) if (!cards.has(id)) cards.set(id, { steamId: id, userId: null, name: id, avatar: "" });
  return cards;
}

export async function userCards(userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const cards = new Map<string, { userId: string; steamId: string; name: string; avatar: string }>();
  if (ids.length === 0) return cards;
  const { data, error } = await db().from("users").select("id,steam_id,username,avatar").in("id", ids);
  legacyXError(error, "Unable to resolve staff");
  for (const row of (data ?? []) as DbRow[]) cards.set(row.id, { userId: row.id, steamId: row.steam_id, name: row.username, avatar: row.avatar ?? "" });
  return cards;
}

/* ---------------------------------------------------------------------------
 * Steam VAC / game bans (ISteamUser/GetPlayerBans), cached for six hours
 * ------------------------------------------------------------------------ */

type SteamBanInfo = { vacBans: number; gameBans: number; daysSinceLastBan: number | null };
const steamBanCache = new Map<string, { at: number; info: SteamBanInfo }>();
const steamBanTtlMs = 6 * 3_600_000;

export async function steamBans(steamIds: string[]): Promise<Map<string, SteamBanInfo>> {
  const result = new Map<string, SteamBanInfo>();
  const missing: string[] = [];
  for (const id of new Set(steamIds)) {
    const hit = steamBanCache.get(id);
    if (hit && Date.now() - hit.at < steamBanTtlMs) result.set(id, hit.info);
    else missing.push(id);
  }
  const key = process.env.STEAM_WEB_API_KEY?.trim();
  if (!key || missing.length === 0) return result;
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    try {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${encodeURIComponent(key)}&steamids=${batch.join(",")}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) continue;
      const body = await response.json() as { players?: DbRow[] };
      for (const player of body.players ?? []) {
        const info = { vacBans: Number(player.NumberOfVACBans) || 0, gameBans: Number(player.NumberOfGameBans) || 0, daysSinceLastBan: player.VACBanned || player.NumberOfGameBans ? Number(player.DaysSinceLastBan) : null };
        steamBanCache.set(String(player.SteamId), { at: Date.now(), info });
        result.set(String(player.SteamId), info);
      }
    } catch {
      // Flags are advisory; a Steam outage must not break the panel.
    }
  }
  return result;
}

/* ---------------------------------------------------------------------------
 * Row flags for server tabs and profiles
 * ------------------------------------------------------------------------ */

export type PlayerFlags = {
  previousBan: boolean;
  vacBans: number;
  gameBans: number;
  newAccount: boolean;
  manyNameChanges: boolean;
  firstVisit: boolean;
};

export const newAccountDays = 7;
export const manyNamesThreshold = 3;

export async function playerFlags(steamIds: string[], serverId?: string): Promise<Map<string, PlayerFlags>> {
  const ids = [...new Set(steamIds)];
  const flags = new Map<string, PlayerFlags>();
  if (ids.length === 0) return flags;
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [bans, names, firstSessions, serverSessions, vac] = await Promise.all([
    db().from("bans").select("steam_id").in("steam_id", ids),
    db().from("player_name_history").select("steam_id").in("steam_id", ids).gte("last_seen_at", monthAgo),
    db().from("player_sessions").select("steam_id,connected_at").in("steam_id", ids).order("connected_at").limit(ids.length * 50),
    serverId ? db().from("player_sessions").select("steam_id").in("steam_id", ids).eq("server_id", serverId) : Promise.resolve({ data: [], error: null }),
    steamBans(ids),
  ]);
  legacyXError(bans.error || names.error || firstSessions.error || serverSessions.error, "Unable to compute player flags");

  const banned = new Set(((bans.data ?? []) as DbRow[]).map(row => row.steam_id));
  const nameCounts = new Map<string, number>();
  for (const row of (names.data ?? []) as DbRow[]) nameCounts.set(row.steam_id, (nameCounts.get(row.steam_id) ?? 0) + 1);
  const firstSeen = new Map<string, number>();
  for (const row of (firstSessions.data ?? []) as DbRow[]) if (!firstSeen.has(row.steam_id)) firstSeen.set(row.steam_id, new Date(row.connected_at).getTime());
  const visits = new Map<string, number>();
  for (const row of (serverSessions.data ?? []) as DbRow[]) visits.set(row.steam_id, (visits.get(row.steam_id) ?? 0) + 1);

  for (const id of ids) {
    const first = firstSeen.get(id);
    flags.set(id, {
      previousBan: banned.has(id),
      vacBans: vac.get(id)?.vacBans ?? 0,
      gameBans: vac.get(id)?.gameBans ?? 0,
      newAccount: first === undefined || Date.now() - first < newAccountDays * 86_400_000,
      manyNameChanges: (nameCounts.get(id) ?? 0) >= manyNamesThreshold,
      firstVisit: serverId ? (visits.get(id) ?? 0) <= 1 : false,
    });
  }
  return flags;
}
