import { syncSteamUserProfile } from "./steamProfile";
import { legacyXDb } from "./supabase";

/**
 * Players the game servers create an account for without a website sign-in (a ban, a match result, a first skin pick) start with the
 * placeholder name "Steam <id>" and no picture. The heartbeat names who is on a server, so the ones that are still bare get their
 * Steam name and avatar then, a few at a time and at most once an hour each. Best effort: a missing Steam key or Steam being down
 * only means they stay bare for now.
 */

const RETRY_AFTER_MS = 60 * 60_000;
const PER_HEARTBEAT = 3;
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
