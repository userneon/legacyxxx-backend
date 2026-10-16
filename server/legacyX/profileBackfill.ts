import { syncSteamUserProfile } from "./steamProfile";
import { legacyXDb } from "./supabase";

/**
 * Players the game servers create an account for without a website sign-in (a ban, a match result, a first skin pick) start with the
 * placeholder name "Steam <id>" and no picture. The heartbeat names who is on a server, so the ones that are still bare get their
 * Steam name and avatar then, a few at a time and at most once an hour each. Best effort: a missing Steam key or Steam being down
 * only means they stay bare for now.
 */

const RETRY_AFTER_MS = 60 * 60_000;
const PER_HEARTBEAT = 5;
const tried = new Map<string, number>();

/** Which of these Steam IDs may be tried now: not tried in the last hour, at most `limit`. Marks them as tried. */
export function pickToBackfill(steamIds: string[], now = Date.now(), limit = PER_HEARTBEAT, seen = tried): string[] {
  const picked: string[] = [];
  for (const id of steamIds) {
    if (picked.length >= limit) break;
    const last = seen.get(id);
    if (last !== undefined && now - last < RETRY_AFTER_MS) continue;
    seen.set(id, now);
    picked.push(id);
  }
  if (seen.size > 5000) Array.from(seen.entries()).forEach(([id, at]) => { if (now - at >= RETRY_AFTER_MS) seen.delete(id); });
  return picked;
}

/** True for an account that has no picture or still carries the placeholder name. */
export function isBare(user: { username?: string | null; avatar?: string | null }): boolean {
  return !user.avatar || /^Steam \d{15,20}$/.test(user.username ?? "");
}

export interface OnServer { steamId: string; name?: string | null }

const PLACEHOLDER = /^Steam \d{15,20}$/;
const cleanName = (name: string | null | undefined) => (name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);

/**
 * When Steam gives no name (no key, Steam down, private profile), the name the player has in the game is better than "Steam <id>".
 * It only replaces the placeholder, never a name Steam or the player already set.
 */
export async function nameFromGame(players: OnServer[]): Promise<number> {
  const named = players.filter((player) => cleanName(player.name) && !PLACEHOLDER.test(cleanName(player.name)) && /^\d{17}$/.test(player.steamId));
  if (named.length === 0) return 0;
  const db = legacyXDb();
  const { data, error } = await db.from("users").select("steam_id,username").in("steam_id", named.map((player) => player.steamId));
  if (error) return 0;
  const bare = new Set(((data ?? []) as Array<{ steam_id: string; username: string | null }>).filter((user) => PLACEHOLDER.test(user.username ?? "")).map((user) => user.steam_id));
  let done = 0;
  for (const player of named) {
    if (!bare.has(player.steamId)) continue;
    const { error: updateError } = await db.from("users").update({ username: cleanName(player.name) }).eq("steam_id", player.steamId).like("username", "Steam %");
    if (!updateError) done += 1;
  }
  return done;
}

/** Players not yet known to the database, among these Steam IDs (the valid ones, once per hour each, at most `limit` per call). */
export function pickMissing(steamIds: string[], known: Set<string>, now = Date.now(), limit = 10, seen = createTried): string[] {
  const picked: string[] = [];
  for (const id of steamIds) {
    if (picked.length >= limit) break;
    if (known.has(id)) continue;
    const last = seen.get(id);
    if (last !== undefined && now - last < RETRY_AFTER_MS) continue;
    seen.set(id, now);
    picked.push(id);
  }
  if (seen.size > 5000) Array.from(seen.entries()).forEach(([id, at]) => { if (now - at >= RETRY_AFTER_MS) seen.delete(id); });
  return picked;
}
const createTried = new Map<string, number>();

/**
 * Everyone who plays on a server has an account, whether or not they ever signed in on the website: ranks, stats, skins and
 * penalties all hang on it. The placeholder "Steam <id>" account is created the first time the heartbeat lists them, and
 * signing in later with the same Steam account picks it up. Returns how many were created.
 */
export async function ensureAccounts(steamIds: string[]): Promise<number> {
  const unique = Array.from(new Set(steamIds.filter((id) => /^7656119\d{10}$/.test(id))));
  if (unique.length === 0) return 0;
  const db = legacyXDb();
  const { data, error } = await db.from("users").select("steam_id").in("steam_id", unique);
  if (error) return 0;
  const known = new Set(((data ?? []) as Array<{ steam_id: string }>).map((row) => row.steam_id));
  let created = 0;
  for (const steamId of pickMissing(unique, known)) {
    const { error: createError } = await db.rpc("ensure_steam_user", { p_steam_id: steamId, p_username: `Steam ${steamId}`, p_avatar: "" });
    if (createError) continue;
    created += 1;
    // Name and picture right away, so the leaderboard never shows the placeholder for them.
    await syncSteamUserProfile(steamId).catch(() => undefined);
  }
  return created;
}

export async function backfillProfiles(steamIds: string[]): Promise<number> {
  const unique = Array.from(new Set(steamIds.filter((id) => /^\d{17}$/.test(id))));
  if (unique.length === 0) return 0;
  const { data, error } = await legacyXDb().from("users").select("steam_id,username,avatar").in("steam_id", unique);
  if (error) return 0;
  const bare = ((data ?? []) as Array<{ steam_id: string; username: string | null; avatar: string | null }>).filter(isBare).map((user) => user.steam_id);
  let done = 0;
  for (const steamId of pickToBackfill(bare)) {
    try {
      await syncSteamUserProfile(steamId);
      done += 1;
    } catch {
      // Steam or the key is not available right now: it is tried again in an hour.
    }
  }
  return done;
}
