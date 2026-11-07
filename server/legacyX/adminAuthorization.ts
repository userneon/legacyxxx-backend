import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { legacyXError } from "./supabase";
import { playModeFromServerMode } from "./play";
import { effectiveExtras, isAdminLevel } from "./adminLevels";
import { effectivePerkCommands } from "./perks";
import { GAME_ROLES, defaultGameRole, flagsFor, isGameRole, mergeGameRoles, parseGameRole, type GameRoleConfig, type GameRoleKey } from "./gameRoles";

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
/** "creator" and "main_creator" are the content creators (owner request 2026-11-02): fun commands on fun servers, and nothing that punishes. */
export type GameStaffRole = (typeof GAME_STAFF_ROLES)[number] | "creator" | "main_creator" | "perk" | "player";

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
  /** The staff member's website clan tag (shown in Tab as [CLAN | ROLE]); null when they have none. Cosmetic only. */
  clanTag: string | null;
  /** What the plugin gives this player, from the role as edited on the staff site (absent for an Owner: that role is built into the plugin). */
  /** The name shown in Tab instead of the role's own (a paid rank's name, chosen by the Owner). */
  label?: string;
  grant?: { flags: string[]; commands: string[]; immunity: number; limits?: Record<string, { cooldown: number; perMap: number }> } | null;
};

const resolvedRowSchema = z.object({
  steam_id: z.string(),
  role: z.string(),
  status: z.string(),
  source: z.string(),
  expires_at: z.string().nullable(),
});

function unauthorized(steamId: string, status = "none", source = "none"): PlayerAuthorization {
  return { steamId, authorized: false, role: "player", status, source, expiresAt: null, clanTag: null };
}


/** Which of these players are content creators (Main or plain). Fail closed: any error gives nobody a role. */
async function creatorRolesFor(db: Db, steamIds: string[]): Promise<Map<string, "creator" | "main_creator">> {
  const roles = new Map<string, "creator" | "main_creator">();
  if (steamIds.length === 0) return roles;
  try {
    const { data, error } = await db.from("content_creators").select("tier,users!content_creators_user_id_fkey!inner(steam_id)").in("users.steam_id", steamIds);
    if (error) return roles;
    for (const row of (Array.isArray(data) ? data : []) as Array<{ tier?: unknown; users?: unknown }>) {
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      const steamId = typeof (user as { steam_id?: unknown } | undefined)?.steam_id === "string" ? (user as { steam_id: string }).steam_id : "";
      if (steamId && steamIds.includes(steamId)) roles.set(steamId, row.tier === "main" ? "main_creator" : "creator");
    }
  } catch (error) {
    console.warn("[legacy-x-api] creator roles unavailable", error instanceof Error ? error.message : error);
  }
  return roles;
}

/** Players with a paid rank running: their tier, its name, the picked commands. Fail closed: any error gives nobody a rank. */
async function perkRanksFor(db: Db, steamIds: string[], now: Date): Promise<Map<string, { tier: string; name: string; endsAt: string; commands: unknown }>> {
  const ranks = new Map<string, { tier: string; name: string; endsAt: string; commands: unknown }>();
  if (steamIds.length === 0) return ranks;
  try {
    const { data, error } = await db.from("perk_grants").select("tier,ends_at,commands,users!inner(steam_id)").gt("ends_at", now.toISOString()).in("users.steam_id", steamIds);
    if (error || !Array.isArray(data) || data.length === 0) return ranks;
    const tiers = await db.from("perk_tiers").select("key,name");
    const names = new Map<string, string>(((tiers.data ?? []) as Array<{ key: string; name: string }>).map((row) => [row.key, row.name]));
    for (const row of data as Array<{ tier?: unknown; ends_at?: unknown; commands?: unknown; users?: unknown }>) {
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      const steamId = typeof (user as { steam_id?: unknown } | undefined)?.steam_id === "string" ? (user as { steam_id: string }).steam_id : "";
      if (steamId && typeof row.tier === "string" && typeof row.ends_at === "string") ranks.set(steamId, { tier: row.tier, name: names.get(row.tier) ?? "", endsAt: row.ends_at, commands: row.commands });
    }
  } catch (error) {
    console.warn("[legacy-x-api] paid ranks unavailable", error instanceof Error ? error.message : error);
  }
  return ranks;
}

/** Every editable role as it stands: the stored version, or the built-in one when nothing valid is stored or the table cannot be read. */
export async function loadGameRoles(db: Db): Promise<Map<GameRoleKey, GameRoleConfig & { stored: boolean; updatedAt: string | null }>> {
  const roles = new Map<GameRoleKey, GameRoleConfig & { stored: boolean; updatedAt: string | null }>();
  let rows: Array<{ role?: unknown; config?: unknown; updated_at?: unknown }> = [];
  try {
    const result = await db.from("game_roles").select("role,config,updated_at");
    if (!result?.error && Array.isArray(result?.data)) rows = result.data;
  } catch (error) {
    console.warn("[legacy-x-api] game roles unavailable", error instanceof Error ? error.message : error);
  }
  for (const role of GAME_ROLES) {
    const row = rows.find((entry) => entry.role === role);
    const valid = row ? parseGameRole(row.config) : null;
    roles.set(role, { ...(valid ?? defaultGameRole(role)), stored: Boolean(valid), updatedAt: valid && typeof row?.updated_at === "string" ? row.updated_at : null });
  }
  return roles;
}

/** The extra commands and the level of these Admins (the staff rows). Fail closed: an unreadable answer gives nobody an extra command. */
async function adminExtrasFor(db: Db, steamIds: string[]): Promise<Map<string, { level: string; commands: unknown }>> {
  const extras = new Map<string, { level: string; commands: unknown }>();
  if (steamIds.length === 0) return extras;
  try {
    const { data, error } = await db.from("staff").select("admin_level,extra_commands,users!inner(steam_id)").eq("status", "active").in("users.steam_id", steamIds);
    if (error) return extras;
    for (const row of (Array.isArray(data) ? data : []) as Array<{ admin_level?: unknown; extra_commands?: unknown; users?: unknown }>) {
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      const steamId = typeof (user as { steam_id?: unknown } | undefined)?.steam_id === "string" ? (user as { steam_id: string }).steam_id : "";
      if (steamId) extras.set(steamId, { level: isAdminLevel(row.admin_level) ? row.admin_level : "admin", commands: row.extra_commands });
    }
  } catch (error) {
    console.warn("[legacy-x-api] admin extra commands unavailable", error instanceof Error ? error.message : error);
  }
  return extras;
}

/** Staff show their clan before their role in Tab. Purely cosmetic: any failure just leaves the tag out. */
async function addClanTags(db: Db, staff: PlayerAuthorization[]) {
  if (staff.length === 0) return;
  try {
    const users = await db.from("users").select("id,steam_id").in("steam_id", staff.map((entry) => entry.steamId));
    if (users.error || !users.data?.length) return;
    const bySteam = new Map<string, string>(users.data.map((user: { id: string; steam_id: string }) => [user.id, user.steam_id]));
    const members = await db.from("clan_members").select("user_id,clans(tag)").in("user_id", Array.from(bySteam.keys()));
    if (members.error) return;
    for (const row of (members.data ?? []) as Array<{ user_id: string; clans?: { tag?: string } | Array<{ tag?: string }> | null }>) {
      const clan = Array.isArray(row.clans) ? row.clans[0] : row.clans;
      const steamId = bySteam.get(row.user_id);
      const entry = staff.find((candidate) => candidate.steamId === steamId);
      if (entry && clan?.tag) entry.clanTag = clan.tag;
    }
  } catch (error) {
    console.warn("[legacy-x-api] staff clan tags unavailable", (error as Error)?.message);
  }
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
    bySteamId.set(steamId, { steamId, authorized: true, role: role as GameStaffRole, status, source, expiresAt: expiry ? expiry.toISOString() : null, clanTag: null });
  }
  // The roles a player holds besides their first (owner request 2026-11-07: a Content Creator may be staff too, a paid rank may sit on either, "whatever the combination"):
  // the first is staff, else creator, else the paid rank; every other one they hold adds its commands, flags and limits to theirs.
  const creators = await creatorRolesFor(db, steamIds);
  const ranks = await perkRanksFor(db, steamIds, now);
  const also = new Map<string, GameRoleKey[]>();
  const alsoAdd = (steamId: string, role: GameRoleKey) => also.set(steamId, [...(also.get(steamId) ?? []), role]);
  creators.forEach((role, steamId) => {
    if (bySteamId.get(steamId)?.authorized) alsoAdd(steamId, role);
    else bySteamId.set(steamId, { steamId, authorized: true, role, status: "active", source: "creator", expiresAt: null, clanTag: null });
  });
  // The paid rank is the first role only for someone with nothing else; the plugin knows it as a creator-style role with its own name in Tab.
  ranks.forEach((rank, steamId) => {
    if (bySteamId.get(steamId)?.authorized) alsoAdd(steamId, "perk");
    else bySteamId.set(steamId, { steamId, authorized: true, role: "perk", status: "active", source: "perk", expiresAt: rank.endsAt, clanTag: null, ...(rank.name ? { label: rank.name } : {}) });
  });
  // Each editable role is what the Owner set on the staff site: its commands, its immunity, and the kinds of server it works on.
  // A role limited to some kinds of server gets nothing on another (or on one whose kind is not known): fail closed.
  const configs = await loadGameRoles(db);
  const authorized = Array.from(bySteamId.values()).filter((entry) => entry.authorized && isGameRole(entry.role));
  const limited = authorized.some((entry) => (configs.get(entry.role as GameRoleKey)?.modes.length ?? 0) > 0 || (also.get(entry.steamId) ?? []).some((role) => (configs.get(role)?.modes.length ?? 0) > 0));
  let serverMode: string | null = null;
  if (limited) {
    try {
      const server = await db.from("reconnect_servers").select("current_mode").eq("server_id", input.serverId).maybeSingle();
      serverMode = server.error ? null : playModeFromServerMode(server.data?.current_mode);
    } catch { serverMode = null; }
  }
  // An Admin's extra commands (owner request 2026-11-07), by their level: read once for all the Admins asked about.
  const extras = await adminExtrasFor(db, authorized.filter((entry) => entry.role === "admin").map((entry) => entry.steamId));
  /** What one role gives this player on this server: its commands (a paid rank's picks and an Admin's extras included), or nothing where its kind of server does not match. */
  const roleGrant = (role: GameRoleKey, steamId: string): GameRoleConfig | null => {
    const config = configs.get(role) ?? defaultGameRole(role);
    if (config.modes.length > 0 && (!serverMode || !(config.modes as string[]).includes(serverMode))) return null;
    const rank = role === "perk" ? ranks.get(steamId) : undefined;
    const picked = role === "admin" ? effectiveExtras(extras.get(steamId)?.level, extras.get(steamId)?.commands, config.commands) : [];
    const perkPicks = rank ? effectivePerkCommands({ tier: rank.tier, endsAt: rank.endsAt, commands: rank.commands }, now) : [];
    const added = picked.length ? picked : perkPicks;
    return added.length ? { ...config, commands: Array.from(new Set([...config.commands, ...added])).sort() } : config;
  };
  for (const entry of authorized) {
    let given = roleGrant(entry.role as GameRoleKey, entry.steamId);
    if (!given) { bySteamId.set(entry.steamId, unauthorized(entry.steamId, "mode", entry.source)); continue; }
    for (const role of also.get(entry.steamId) ?? []) {
      const more = roleGrant(role, entry.steamId);
      if (more) given = mergeGameRoles(given, more);
    }
    entry.grant = { flags: flagsFor(given), commands: given.commands, immunity: given.immunity, limits: given.limits };
  }
  await addClanTags(db, Array.from(bySteamId.values()).filter((entry) => entry.authorized));
  // The plugin knows a paid rank as a creator (fun commands, nothing that punishes); its own commands and name come in the grant and the label.
  Array.from(bySteamId.values()).forEach((entry) => { if (entry.role === "perk") entry.role = "creator"; });
  return steamIds.map((steamId) => bySteamId.get(steamId) ?? unauthorized(steamId));
}
