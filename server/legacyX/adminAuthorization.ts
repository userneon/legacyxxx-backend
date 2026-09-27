import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { legacyXError } from "./supabase";

/**
 * In-game staff authorization for LegacyX-Admin (POST /plugin/admin/authorizations).
 *
 * The game server asks about the players it has connected; the database function
 * legacy_x.resolve_game_staff decides each player's role on that server (a per-server assignment
 * first, then the global staff role). The plugin grants CounterStrikeSharp permissions only for an
 * answer with `authorized: true`, so anything this module can't vouch for comes back unauthorized.
 */

type Db = SupabaseClient<any, any, any, any, any>;

export const GAME_STAFF_ROLES = ["owner", "manager", "admin", "staff"] as const;
export type GameStaffRole = (typeof GAME_STAFF_ROLES)[number] | "player";

const steamId64 = z.string().regex(/^7656119\d{10}$/, "SteamID64 is required");

export const authorizationRequestSchema = z.object({
  /** The LEGACYX_SERVER_ID of the asking game server. */
  serverId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, "serverId must be 1-64 characters of A-Z a-z 0-9 . _ : -"),
  steamIds: z.array(steamId64).min(1).max(64),
}).strict();

export type PlayerAuthorization = {
  steamId: string;
  authorized: boolean;
  role: GameStaffRole;
  /** active | suspended | revoked | expired | none */
  status: string;
  /** server | global | none: which record decided. */
  source: string;
  expiresAt: string | null;
};

const resolvedRowSchema = z.object({
  steam_id: z.string(),
  role: z.string(),
  status: z.string(),
  source: z.string(),
  expires_at: z.string().nullable(),
});

function unauthorized(steamId: string, status = "none", source = "none"): PlayerAuthorization {
  return { steamId, authorized: false, role: "player", status, source, expiresAt: null };
}

/** One answer per requested SteamID, in request order. */
export async function resolveAuthorizations(db: Db, input: z.infer<typeof authorizationRequestSchema>, now = new Date()): Promise<PlayerAuthorization[]> {
  const steamIds = Array.from(new Set(input.steamIds));
  const { data, error } = await db.rpc("resolve_game_staff", { p_server_id: input.serverId, p_steam_ids: steamIds });
  legacyXError(error, "Unable to resolve in-game staff authorization");

  const bySteamId = new Map<string, PlayerAuthorization>();
  for (const raw of Array.isArray(data) ? data : []) {
    const row = resolvedRowSchema.safeParse(raw);
    if (!row.success || !steamIds.includes(row.data.steam_id)) continue;
    const { steam_id: steamId, role, status, source, expires_at: expiresAt } = row.data;
    const expiry = expiresAt ? new Date(expiresAt) : null;
    const expired = expiry !== null && !(expiry.getTime() > now.getTime());
    const knownRole = (GAME_STAFF_ROLES as readonly string[]).includes(role);
    if (!knownRole || status !== "active" || expired) {
      bySteamId.set(steamId, unauthorized(steamId, expired && status === "active" ? "expired" : status, source));
      continue;
    }
    bySteamId.set(steamId, { steamId, authorized: true, role: role as GameStaffRole, status, source, expiresAt: expiry ? expiry.toISOString() : null });
  }
  return steamIds.map((steamId) => bySteamId.get(steamId) ?? unauthorized(steamId));
}
