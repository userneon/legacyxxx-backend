import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { activeBannedUserIds, ownerSteamIds } from "./bans";
import { legacyXError } from "./supabase";

/**
 * Detections from the CS2AC anti-cheat (owner request 2026-11-06). The game server reports each one here before banning anybody; this decides whether the
 * detection is a ban or only a flag, writes the evidence, and says why. The server then runs the ordinary ban (LegacyX-Admin `css_ban`) only when told to.
 * The rules are plain and short so a wrong ban can be explained and a rule can be changed in one place:
 *   - never a ban for staff, or for someone who is banned already;
 *   - never a ban while the server is in warmup, is a Fun server, or the player holds one of our cheat toys (they would be "detected" by design);
 *   - never a ban when the same detector fired on three or more other players of that server within a minute (that is the server, not cheaters);
 *   - then by how sure the detector is: the heavy ones ban at once, the medium ones on the second detection within ten minutes, the rest never alone.
 */

type Db = SupabaseClient<any, any, any, any, any>;

const steamId64 = z.string().regex(/^7656119\d{10}$/, "SteamID64 is required");

export const anticheatFlagSchema = z.object({
  steamId: steamId64,
  detector: z.string().trim().min(1).max(48),
  detail: z.string().trim().max(200).optional(),
  serverId: z.string().trim().max(120).optional(),
  map: z.string().trim().max(64).optional(),
  mode: z.string().trim().max(32).optional(),
  /** What the game server knew: set only the ones that are true. */
  context: z.object({
    warmup: z.boolean().default(false),
    funServer: z.boolean().default(false),
    cheatToys: z.boolean().default(false),
  }).default({ warmup: false, funServer: false, cheatToys: false }),
});
export type AnticheatFlagInput = z.infer<typeof anticheatFlagSchema>;

export type DetectorTier = "heavy" | "medium" | "low";

const HEAVY = ["aimbot", "aimlock", "silentaim", "silent aim", "antiaim", "anti-aim", "anti aim", "doubletap", "double tap"];
const MEDIUM = ["inhuman accuracy", "irregular behavior", "irregular behaviour", "bhop", "autostrafe", "hyperscroll", "dll injection"];

/** How sure a detector is, by its name (the text CS2AC sends in {detection}); an unknown name is the lowest tier. */
export function detectorTier(detector: string): DetectorTier {
  const name = detector.trim().toLowerCase();
  if (HEAVY.some((entry) => name.includes(entry))) return "heavy";
  if (MEDIUM.some((entry) => name.includes(entry))) return "medium";
  return "low";
}

export const MASS_DETECTION_WINDOW_MS = 60_000;
export const MASS_DETECTION_PLAYERS = 3;
export const REPEAT_WINDOW_MS = 10 * 60_000;

export interface AnticheatState {
  isStaff: boolean;
  alreadyBanned: boolean;
  /** Earlier detections of this detector on this player within REPEAT_WINDOW_MS. */
  earlierDetections: number;
  /** Other players this detector flagged on this server within MASS_DETECTION_WINDOW_MS. */
  otherPlayersRecently: number;
}

export interface AnticheatDecision { action: "ban" | "flag"; decision: string; reason: string }

/** The whole policy, pure so it can be tested. */
export function decideAnticheatAction(input: AnticheatFlagInput, state: AnticheatState): AnticheatDecision {
  const detector = input.detector.trim();
  const reason = `CS2AC: ${detector}`.slice(0, 200);
  const flag = (decision: string): AnticheatDecision => ({ action: "flag", decision, reason });
  if (state.isStaff) return flag("A staff member or owner is never banned automatically.");
  if (state.alreadyBanned) return flag("Already banned.");
  if (input.context.cheatToys) return flag("The player holds one of the server's own cheat toys.");
  if (input.context.funServer) return flag("A Fun server.");
  if (input.context.warmup) return flag("Warmup: a detection then is not reliable.");
  if (state.otherPlayersRecently >= MASS_DETECTION_PLAYERS) return flag(`The same detector fired on ${state.otherPlayersRecently} other players of this server within a minute: probably the server, not cheaters.`);
  const tier = detectorTier(detector);
  if (tier === "heavy") return { action: "ban", decision: "A heavy detector: banned at once.", reason };
  if (tier === "medium") {
    return state.earlierDetections >= 1
      ? { action: "ban", decision: `A medium detector, second detection within ten minutes: banned.`, reason: `${reason} (x${state.earlierDetections + 1})`.slice(0, 200) }
      : flag("A medium detector, first detection: flagged, a second within ten minutes bans.");
  }
  return flag("A detector that never bans alone.");
}

/** Reads what the policy needs from the database; a failed read throws (the caller then bans nobody on its own). */
export async function readAnticheatState(db: Db, input: AnticheatFlagInput, now = new Date()): Promise<{ state: AnticheatState; userId: string | null }> {
  const { data: user, error: userError } = await db.from("users").select("id").eq("steam_id", input.steamId).maybeSingle();
  legacyXError(userError, "Unable to find the flagged player");
  const userId = (user as { id?: string } | null)?.id ?? null;
  const [alreadyBanned, owners, staff, earlier, others] = await Promise.all([
    userId ? activeBannedUserIds(db, [userId]).then((set) => set.has(userId)) : Promise.resolve(false),
    ownerSteamIds(db, [input.steamId]),
    userId ? db.from("staff").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "active") : Promise.resolve({ count: 0, error: null }),
    db.from("anticheat_flags").select("id", { count: "exact", head: true }).eq("steam_id", input.steamId).ilike("detector", input.detector).gte("created_at", new Date(now.getTime() - REPEAT_WINDOW_MS).toISOString()),
    input.serverId
      ? db.from("anticheat_flags").select("steam_id").eq("server_id", input.serverId).ilike("detector", input.detector).neq("steam_id", input.steamId).gte("created_at", new Date(now.getTime() - MASS_DETECTION_WINDOW_MS).toISOString()).limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  legacyXError(staff.error || earlier.error || others.error, "Unable to read the anti-cheat history");
  const otherPlayers = new Set(((others.data ?? []) as Array<{ steam_id: string }>).map((row) => row.steam_id));
  return {
    userId,
    state: {
      isStaff: owners.has(input.steamId) || (staff.count ?? 0) > 0,
      alreadyBanned,
      earlierDetections: earlier.count ?? 0,
      otherPlayersRecently: otherPlayers.size,
    },
  };
}

/** Decides and records one detection; returns what the game server should do. */
export async function recordAnticheatFlag(db: Db, input: AnticheatFlagInput, now = new Date()) {
  const { state, userId } = await readAnticheatState(db, input, now);
  const decision = decideAnticheatAction(input, state);
  const { data, error } = await db.from("anticheat_flags").insert({
    steam_id: input.steamId,
    user_id: userId,
    detector: input.detector,
    detail: input.detail ?? null,
    server_id: input.serverId ?? null,
    map_name: input.map ?? null,
    server_mode: input.mode ?? null,
    action: decision.action,
    decision: decision.decision,
    context: { ...input.context, tier: detectorTier(input.detector), earlierDetections: state.earlierDetections, otherPlayersRecently: state.otherPlayersRecently },
  }).select("id").single();
  legacyXError(error, "Unable to record the anti-cheat detection");
  return { id: (data as { id: string }).id, ...decision };
}
