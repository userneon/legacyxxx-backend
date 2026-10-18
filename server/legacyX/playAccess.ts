import type { SupabaseClient } from "@supabase/supabase-js";
import { legacyXError } from "./supabase";

/**
 * Who may join a game server right now (owner request 2026-10-18).
 *
 * Leaving ranked matches: within any 24 hours the 1st and 2nd leave only cost EXP (the leaver rule in ranking.ts), the 3rd also
 * blocks playing for 30 minutes, and every leave after that adds another 30 minutes (4th: 60, 5th: 90 ...). The leaves are the
 * `leaver` rows of competitive_match_exp, so nothing new is stored. The block runs from the latest leave.
 *
 * Logged in: a player is logged in while they hold a refresh session on the website that is neither revoked nor expired.
 * The website's Connect button and the game servers (LegacyX-Admin) both ask this, so nobody gets in by typing the address.
 */

type Db = SupabaseClient<any, any, any, any, any>;

export const LEAVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LEAVE_COOLDOWN_FROM = 3;
export const LEAVE_COOLDOWN_STEP_MINUTES = 30;

export interface LeaveStatus {
  /** Leaves in the last 24 hours. */
  leavesToday: number;
  /** Set while the player is blocked from playing; null otherwise. */
  cooldown: { until: string; minutes: number } | null;
  /** What the next leave would cost: only EXP, or EXP and a block of this many minutes. */
  next: { cooldownMinutes: number };
}

export const cooldownMinutesFor = (leaves: number) => (leaves >= LEAVE_COOLDOWN_FROM ? (leaves - LEAVE_COOLDOWN_FROM + 1) * LEAVE_COOLDOWN_STEP_MINUTES : 0);

/** The block a player is under, from the times of their leaves. */
export function leaveStatus(leaves: ReadonlyArray<string | Date>, now: Date): LeaveStatus {
  const times = leaves
    .map((leave) => new Date(leave).getTime())
    .filter((time) => Number.isFinite(time) && time <= now.getTime() && now.getTime() - time < LEAVE_WINDOW_MS)
    .sort((a, b) => a - b);
  const count = times.length;
  const minutes = cooldownMinutesFor(count);
  const until = minutes > 0 ? times[count - 1]! + minutes * 60_000 : 0;
  return {
    leavesToday: count,
    cooldown: until > now.getTime() ? { until: new Date(until).toISOString(), minutes } : null,
    next: { cooldownMinutes: cooldownMinutesFor(count + 1) },
  };
}

/** The leave times of each user in the last 24 hours. */
export async function loadLeaves(db: Db, userIds: string[], now: Date): Promise<Map<string, string[]>> {
  const leaves = new Map<string, string[]>();
  if (userIds.length === 0) return leaves;
  const since = new Date(now.getTime() - LEAVE_WINDOW_MS).toISOString();
  const { data, error } = await db.from("competitive_match_exp").select("user_id,exp_breakdown,created_at").in("user_id", userIds).gte("created_at", since).limit(2000);
  legacyXError(error, "Unable to load recent leaves");
  for (const row of (data ?? []) as Array<{ user_id: string; exp_breakdown: { rule?: string } | null; created_at: string }>) {
    if (row.exp_breakdown?.rule !== "leaver") continue;
    leaves.set(row.user_id, [...(leaves.get(row.user_id) ?? []), row.created_at]);
  }
  return leaves;
}

/** Which of these users are logged in on the website right now. */
export async function loadLoggedIn(db: Db, userIds: string[], now: Date): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await db.from("user_sessions").select("user_id").in("user_id", userIds).is("revoked_at", null).gt("expires_at", now.toISOString()).limit(2000);
  legacyXError(error, "Unable to read who is logged in");
  return new Set(((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id));
}

export interface PlayerAccess {
  steamId: string;
  /** Has an account and is logged in on the website. */
  loggedIn: boolean;
  cooldown: LeaveStatus["cooldown"];
}

/** Access of players by Steam ID, for the game servers. A Steam ID with no account is not logged in. */
export async function playerAccess(db: Db, steamIds: string[], now = new Date()): Promise<PlayerAccess[]> {
  const unique = Array.from(new Set(steamIds));
  const { data, error } = await db.from("users").select("id,steam_id").in("steam_id", unique);
  legacyXError(error, "Unable to look the players up");
  const byId = new Map(((data ?? []) as Array<{ id: string; steam_id: string }>).map((row) => [row.steam_id, row.id]));
  const ids = Array.from(byId.values());
  const [loggedIn, leaves] = await Promise.all([loadLoggedIn(db, ids, now), loadLeaves(db, ids, now)]);
  return unique.map((steamId) => {
    const userId = byId.get(steamId);
    return {
      steamId,
      loggedIn: userId ? loggedIn.has(userId) : false,
      cooldown: userId ? leaveStatus(leaves.get(userId) ?? [], now).cooldown : null,
    };
  });
}
