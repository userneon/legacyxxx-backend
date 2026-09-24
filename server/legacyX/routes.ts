import { Router, type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { parseCookieHeader } from "../_core/cookieHeader";
import {
  authenticatePlugin,
  createRefreshSession,
  issueAccessToken,
  refreshLifetimeMs,
  revokeRefreshSession,
  revokeUserRefreshSessions,
  rotateRefreshSession,
  sha256,
  steamLoginUrl,
  verifySteamCallback,
  type LegacyUser,
  type PluginPrincipal,
} from "./auth";
import { apiAuthRateLimitMax, apiRateLimitMax, apiSensitiveRateLimitMax, isDeferredFeatureEnabled, publicDeferredFeatureFlags, type DeferredFeatureKey } from "./config";
import { getFaceitProfileSnapshot, getFaceitProfileSnapshotForSteamId, resolveFaceitNickname } from "./faceit";
import { legacyXDb, legacyXError } from "./supabase";
import { resolveSteamProfileMedia } from "./steamBackground";
import { mapCompetitiveMatch, mapMatchRounds } from "./matchDetails";
import { syncSteamUserProfile } from "./steamProfile";
import { apiError, asyncRoute, hasAccessToken, requireUser, userRoute, type ApiRequest } from "./http";
import { createAdminRouter } from "./admin";
import { createTournamentRouter } from "./tournaments";
import { killEventSchema, killFeed } from "./killfeed";
import { applyCompetitiveResult } from "./rank/matchResult";
import { PRO_LEAGUE_KEEP_EXP, PRO_LEAGUE_RANK_ID, PRO_LEAGUE_UNLOCK_EXP, STARTING_EXP, rankById, rankProgress } from "./rank/ranks";


function pluginCredential(req: Request) {
  const value = req.header("authorization");
  if (value?.startsWith("Bearer ")) return value.slice(7).trim();
  const legacyHeader = req.header("x-plugin-secret")?.trim();
  if (legacyHeader) return legacyHeader;
  apiError(401, "Plugin credential is required");
}

/** Public read routes: guests are served as null, while a present-but-invalid token still 401s so the client can refresh it. */
function optionalUserRoute(handler: (req: ApiRequest, res: Response, user: LegacyUser | null) => Promise<void>) {
  return asyncRoute(async (req, res) => handler(req, res, hasAccessToken(req) ? await requireUser(req) : null));
}

type StaffPanelRole = "OWNER" | "MANAGER";
type StaffPrincipal = { staffId: string; userId: string; role: StaffPanelRole; permissions: string[]; username: string };
const staffDirectoryRoleSchema = z.enum(["OWNER", "MANAGER", "ADMIN", "DEVELOPER", "DESIGNER"]);
const staffDirectoryStatusSchema = z.enum(["active", "suspended", "revoked"]);
const staffPermissionListSchema = z.array(z.string().trim().min(1).max(80).regex(/^[a-z0-9_*:-]+$/i)).max(32);
const inGameAdminPermissionSchema = z.enum(["@css/generic", "@css/kick", "@css/ban", "@css/unban", "@css/slay", "@css/changemap", "@css/chat", "@css/vote", "@css/config", "@css/cvar", "@css/rcon", "@css/cheats", "@css/root"]);
const inGameAdminPermissionsSchema = z.array(inGameAdminPermissionSchema).max(13).transform((values) => values.filter((value, index) => values.indexOf(value) === index));
const inGameAdminImmunitySchema = z.number().int().min(0).max(1000);
const inGameAdminStaminaSchema = z.number().int().min(0).max(1000);
const staffRoleNumericDefaults = { OWNER: 1000, MANAGER: 750, ADMIN: 500, DEVELOPER: 0, DESIGNER: 0 } as const;
const staffMemberCreateSchema = z.object({ userId: z.string().uuid(), role: staffDirectoryRoleSchema, permissions: staffPermissionListSchema.default([]), gamePermissions: inGameAdminPermissionsSchema.default([]), stamina: inGameAdminStaminaSchema.optional(), immunity: inGameAdminImmunitySchema.optional(), status: staffDirectoryStatusSchema.default("active") }).strict();
const staffMemberUpdateSchema = z.object({ role: staffDirectoryRoleSchema.optional(), permissions: staffPermissionListSchema.optional(), gamePermissions: inGameAdminPermissionsSchema.optional(), stamina: inGameAdminStaminaSchema.optional(), immunity: inGameAdminImmunitySchema.optional(), status: staffDirectoryStatusSchema.optional() }).strict().refine((value) => Object.keys(value).length > 0, "At least one staff field is required");
const staffMaintenanceSchema = z.object({ website: z.literal("legacyx.cc"), enabled: z.boolean() }).strict();

const managerStaffCapabilities = new Set([
  "overview", "ban", "unban", "kick", "rename", "map_change", "match_announcement", "hud_announcement", "player_hud_alert", "mute", "player_message",
]);

function requireStaffCapability(staff: StaffPrincipal, capability: string) {
  if (staff.role === "OWNER") return;
  if (!managerStaffCapabilities.has(capability)) apiError(403, "Owner access is required for this operation");
  if (staff.permissions.length > 0 && !staff.permissions.includes("*") && !staff.permissions.includes(capability)) {
    apiError(403, "This staff permission is not active");
  }
}

async function requireFreshStaffSession(req: ApiRequest): Promise<StaffPrincipal> {
  const raw = parseCookieHeader(req.headers.cookie ?? "").legacyx_staff_session;
  if (!raw) apiError(401, "Fresh Staff Panel Steam authentication is required");

  const db = legacyXDb();
  const { data: session, error: sessionError } = await db
    .from("staff_sessions")
    .select("staff_id,expires_at,revoked_at")
    .eq("session_hash", sha256(raw))
    .maybeSingle();
  legacyXError(sessionError, "Unable to verify staff session");
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    apiError(401, "Fresh Staff Panel Steam authentication is required");
  }

  const { data: staff, error: staffError } = await db
    .from("staff")
    .select("id,user_id,role,permissions,status,users(username)")
    .eq("id", session.staff_id)
    .eq("status", "active")
    .maybeSingle();
  legacyXError(staffError, "Unable to verify staff access");
  if (!staff || (staff.role !== "OWNER" && staff.role !== "MANAGER")) apiError(403, "Staff panel access is restricted");
  const relatedUser = Array.isArray(staff.users) ? staff.users[0] : staff.users;
  return {
    staffId: staff.id,
    userId: staff.user_id,
    role: staff.role,
    permissions: Array.isArray(staff.permissions) ? staff.permissions.filter((value): value is string => typeof value === "string") : [],
    username: relatedUser && typeof relatedUser.username === "string" ? relatedUser.username : "Staff",
  };
}

function staffPanelRoute(handler: (req: ApiRequest, res: Response, staff: StaffPrincipal) => Promise<void>) {
  return asyncRoute(async (req, res) => handler(req, res, await requireFreshStaffSession(req)));
}

function ownerPanelRoute(handler: (req: ApiRequest, res: Response, staff: StaffPrincipal) => Promise<void>) {
  return staffPanelRoute(async (req, res, staff) => {
    if (staff.role !== "OWNER") apiError(403, "Owner access is required");
    await handler(req, res, staff);
  });
}

function pluginRoute(scope: string, handler: (req: ApiRequest, res: Response, plugin: PluginPrincipal) => Promise<void>) {
  return asyncRoute(async (req, res) => {
    const plugin = await authenticatePlugin(pluginCredential(req), scope);
    req.plugin = plugin;
    await handler(req, res, plugin);
  });
}

function requestOrigin(req: Request) {
  const configuredOrigin = process.env.PUBLIC_API_ORIGIN?.trim().replace(/\/$/, "");
  if (configuredOrigin) return configuredOrigin;
  return `${req.protocol}://${req.get("host")}`;
}

function steamOpenIdOrigin(req: Request) {
  const configuredOrigin = process.env.STEAM_OPENID_ORIGIN?.trim().replace(/\/$/, "");
  return configuredOrigin || requestOrigin(req);
}

function sessionCookieOptions(maxAge: number) {
  const domain = process.env.AUTH_COOKIE_DOMAIN?.trim();
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    domain: domain || undefined,
    path: "/",
    maxAge,
  };
}

function staffSessionCookieOptions(maxAge: number) {
  const domain = process.env.AUTH_COOKIE_DOMAIN?.trim();
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    domain: domain || undefined,
    path: "/api/v1/staff",
    maxAge,
  };
}

async function createStaffSession(userId: string) {
  const { data: staff, error } = await legacyXDb()
    .from("staff")
    .select("id,role,status")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  legacyXError(error, "Unable to verify Staff Panel access");
  if (!staff || (staff.role !== "OWNER" && staff.role !== "MANAGER")) return null;

  const raw = randomBytes(48).toString("base64url");
  const db = legacyXDb();
  const { error: sessionError } = await db.from("staff_sessions").insert({
    staff_id: staff.id,
    session_hash: sha256(raw),
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
  legacyXError(sessionError, "Unable to create Staff Panel session");
  const { error: auditError } = await db.from("staff_audit_logs").insert({
    staff_id: staff.id,
    event_type: "staff_session_started",
    target_type: "staffpanel",
    metadata: { role: staff.role },
  });
  legacyXError(auditError, "Unable to audit Staff Panel session");
  return raw;
}

function postLoginRedirect() {
  const configured = process.env.POST_LOGIN_REDIRECT?.trim();
  if (configured) return configured;
  return process.env.FRONTEND_ORIGIN?.trim() || null;
}

async function getUserWithStats(id: string) {
  const { data, error } = await legacyXDb()
    .from("users")
    .select("id,steam_id,username,avatar,level,rank,faceit_username,faceit_elo,faceit_level,created_at,updated_at,player_stats(*)")
    .eq("id", id)
    .maybeSingle();
  legacyXError(error, "Unable to load player");
  if (!data) apiError(404, "Player was not found");
  return data;
}

function sendPage(res: Response, data: unknown, count: number | null, limit: number, offset: number) {
  res.json({ data, pagination: { limit, offset, total: count ?? 0 } });
}

// Every active catalog row still stores the CS2 source artwork URL rather than an API-owned
// object key, so refusing absolute keys outright left the Skinchanger with no images at all.
// Only these image hosts may reach the browser; anything else is still dropped. Mirroring the
// catalog to STATIC_ASSET_BASE_URL (docs/SKINCHANGER_STATIC_ASSET_HOSTING.md) retires this list.
const CATALOG_IMAGE_HOSTS = new Set([
  "community.akamai.steamstatic.com",
  "community.cloudflare.steamstatic.com",
  "community.fastly.steamstatic.com",
  "cdn.steamstatic.com",
  "cdn.akamai.steamstatic.com",
  "steamcdn-a.akamaihd.net",
  "raw.githubusercontent.com",
]);

function staticStorageUrl(req: Request, key: string | null | undefined) {
  if (!key) return null;
  // Catalog image_key is normally an API-owned object-storage key. A legacy absolute key is
  // served only when it is HTTPS and points at an allowlisted source-artwork host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(key)) {
    try {
      const source = new URL(key);
      return source.protocol === "https:" && CATALOG_IMAGE_HOSTS.has(source.hostname) ? source.toString() : null;
    } catch {
      return null;
    }
  }
  const configuredBase = process.env.STATIC_ASSET_BASE_URL?.trim().replace(/\/$/, "");
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  if (configuredBase) return `${configuredBase}/${encodedKey}`;

  // Development-only fallback. Production runtime validation requires
  // STATIC_ASSET_BASE_URL so catalog images remain direct static/CDN requests.
  const protocol = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const host = req.get("host");
  if (!host) return null;
  return `${protocol}://${host}/manus-storage/${encodedKey}`;
}

async function writePluginAudit(plugin: PluginPrincipal, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown>) {
  const { error } = await legacyXDb().from("audit_logs").insert({
    actor_type: "plugin",
    actor_id: plugin.id,
    action,
    target_type: targetType,
    target_id: targetId,
    metadata,
  });
  legacyXError(error, "Unable to record plugin audit entry");
}

/** Profile boxes a player may hide from others. Penalty history, SteamID, Steam link and rank always stay public. */
const PROFILE_HIDEABLE_SECTIONS = ["kd", "matches", "kills", "faceit", "recent_matches"] as const;
type ProfileHideableSection = typeof PROFILE_HIDEABLE_SECTIONS[number];
/**
 * Names and avatars come only from Steam (synced at sign-in); accepting them here would let a player point every
 * viewer's browser at an arbitrary external image URL.
 */
const profileUpdateSchema = z.object({
  hiddenSections: z.array(z.enum(PROFILE_HIDEABLE_SECTIONS)).max(PROFILE_HIDEABLE_SECTIONS.length).optional(),
  notificationPrefs: z.object({ tournaments: z.boolean(), rankChanges: z.boolean() }).strict().optional(),
}).strict();
const DEFAULT_NOTIFICATION_PREFS = { tournaments: true, rankChanges: true, penalties: true } as const;
function notificationPrefsValue(value: unknown) {
  const prefs = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    tournaments: typeof prefs.tournaments === "boolean" ? prefs.tournaments : DEFAULT_NOTIFICATION_PREFS.tournaments,
    rankChanges: typeof prefs.rank_changes === "boolean" ? prefs.rank_changes : DEFAULT_NOTIFICATION_PREFS.rankChanges,
    // Penalty notices are always on.
    penalties: true,
  };
}
function hiddenSectionsValue(value: unknown): ProfileHideableSection[] {
  if (!Array.isArray(value)) return [];
  return PROFILE_HIDEABLE_SECTIONS.filter((section) => value.includes(section));
}
/** Postgres "undefined column": the privacy migration has not been applied yet. */
function isMissingColumnError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "42703");
}
const STAFF_PROFILE_ROLES: Record<string, string> = { OWNER: "Owner", MANAGER: "Manager", ADMIN: "Admin", DEVELOPER: "Developer", DESIGNER: "Designer" };
const faceitLinkSchema = z.object({ nickname: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "FACEIT nickname contains unsupported characters") });
const pluginServerSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), map: z.string().trim().min(1).max(64), mode: z.string().trim().min(1).max(64), max_players: z.number().int().min(0).max(256), current_players: z.number().int().min(0).max(256), ping: z.number().int().min(0).max(10000).default(0), status: z.enum(["online", "offline", "full"]), ip_address: z.string().max(255).optional(), port: z.number().int().min(1).max(65535).optional() });
const pluginEventIdSchema = z.string().trim().min(8).max(220).regex(/^[A-Za-z0-9:_-]+$/, "event_id contains unsupported characters");
const playerTelemetryEventSchema = z.object({
  event_id: pluginEventIdSchema,
  event_type: z.enum(["round_snapshot", "player_disconnected"]),
  server_id: z.string().trim().min(1).max(120),
  server_mode: z.string().trim().min(1).max(64),
  match_reference: z.string().trim().min(1).max(255),
  map_name: z.string().trim().max(128).default(""),
  steam_id: z.string().regex(/^\d{15,20}$/),
  player_name: z.string().trim().max(128).default(""),
  round_number: z.coerce.number().int().min(0).max(500),
  match_state: z.enum(["waiting", "live", "paused", "ended"]),
  active_seconds: z.coerce.number().int().min(0).max(172800),
  disconnect_method: z.enum(["client_disconnect", "admin_kick", "admin_ban", "server_shutdown", "unknown"]).nullable().optional(),
  disconnect_reason: z.string().trim().max(160).nullable().optional(),
  metrics: z.object({
    kills: z.coerce.number().int().min(0).max(500),
    deaths: z.coerce.number().int().min(0).max(500),
    damage_dealt: z.coerce.number().int().min(0).max(100000),
    damage_taken: z.coerce.number().int().min(0).max(100000),
  }).strict(),
}).strict();
const phantomVectorSchema = z.object({ x: z.number().finite().min(-32768).max(32768), y: z.number().finite().min(-32768).max(32768), z: z.number().finite().min(-4096).max(32768) }).strict();
const phantomEvidenceSchema = z.object({
  event_id: pluginEventIdSchema,
  match_reference: z.string().trim().min(1).max(255),
  server_id: z.string().trim().min(1).max(120),
  server_mode: z.string().trim().min(1).max(64),
  steam_id: z.string().regex(/^\d{15,20}$/),
  phantom_id: z.string().uuid(),
  mapped_steam_id: z.string().regex(/^\d{15,20}$/),
  phantom_position: phantomVectorSchema,
  player_position: phantomVectorSchema,
  round_number: z.coerce.number().int().min(0).max(500),
  tick: z.coerce.number().int().min(0).max(9_223_372_036_854_775),
  interaction_type: z.enum(["aim_correlation", "shot_correlation"]),
  interaction_count: z.coerce.number().int().min(1).max(1000),
  aim_correlation: z.coerce.number().finite().min(0).max(1),
  movement_correlation: z.coerce.number().finite().min(0).max(1),
  wall_interaction: z.coerce.number().finite().min(0).max(1),
  shot_interaction: z.coerce.number().finite().min(0).max(1),
  suspicion_score: z.coerce.number().finite().min(0).max(100),
  evidence_confidence: z.coerce.number().finite().min(0).max(1),
  occurred_at: z.string().datetime({ offset: true }),
}).strict();
const phantomSuspensionSignalSchema = z.object({
  event_id: pluginEventIdSchema,
  match_reference: z.string().trim().min(1).max(255),
  server_id: z.string().trim().min(1).max(120),
  server_mode: z.string().trim().min(1).max(64),
  steam_id: z.string().regex(/^\d{15,20}$/),
  event_type: z.enum(["suspended", "suspended_disconnect", "restored"]),
  round_number: z.coerce.number().int().min(0).max(500),
  suspicion_score: z.coerce.number().finite().min(0).max(100),
  evidence_count: z.coerce.number().int().min(1).max(10_000),
  evidence_summary: z.object({ phantom_ids: z.array(z.string().uuid()).max(64), latest_interaction: z.enum(["aim_correlation", "shot_correlation"]), evidence_confidence: z.coerce.number().finite().min(0).max(1) }).strict(),
  occurred_at: z.string().datetime({ offset: true }),
}).strict();
const phantomHistoryVectorSchema = z.object({ x: z.number().finite().min(-32768).max(32768), y: z.number().finite().min(-32768).max(32768), z: z.number().finite().min(-4096).max(32768) }).strict();
const phantomHistorySampleSchema = z.object({ sequence: z.coerce.number().int().min(0).max(599), offset_ms: z.coerce.number().int().min(0).max(180_000), position: phantomHistoryVectorSchema, view: z.object({ pitch: z.number().finite().min(-89).max(89), yaw: z.number().finite().min(-180).max(180) }).strict(), velocity: phantomHistoryVectorSchema, crouched: z.boolean() }).strict();
const phantomHistoryRoundSchema = z.object({
  source_ref: z.string().uuid(),
  match_reference: z.string().trim().min(1).max(255),
  server_id: z.string().trim().min(1).max(120),
  server_mode: z.string().trim().min(1).max(64),
  map_name: z.string().trim().min(1).max(128),
  round_number: z.coerce.number().int().min(1).max(500),
  completed_at: z.string().datetime({ offset: true }),
  samples: z.array(phantomHistorySampleSchema).min(3).max(600),
}).strict().superRefine((input, context) => {
  for (let index = 1; index < input.samples.length; index += 1) {
    if (input.samples[index].sequence <= input.samples[index - 1].sequence || input.samples[index].offset_ms <= input.samples[index - 1].offset_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["samples", index], message: "History samples must be strictly ordered" });
  }
});
const phantomCaseReviewSchema = z.object({ decision: z.enum(["clear", "keep", "confirm_ban"]), note: z.string().trim().min(8).max(1000) }).strict();
const liveMatchPlayerSchema = z.object({
  steam_id: z.string().regex(/^\d{15,20}$/),
  name: z.string().trim().min(1).max(128),
  connected: z.boolean().default(true),
  rank_id: z.coerce.number().int().min(1).max(18).nullable().optional(),
  rank_name: z.string().trim().min(1).max(64).nullable().optional(),
  rank_image_key: z.string().trim().regex(/^rank-(0[1-9]|1[0-8])$/).nullable().optional(),
  adr: z.coerce.number().finite().min(0).max(999).nullable().optional(),
  ping: z.coerce.number().int().min(0).max(1_000).nullable().optional(),
  kills: z.coerce.number().int().min(0).max(999).nullable().optional(),
  deaths: z.coerce.number().int().min(0).max(999).nullable().optional(),
  assists: z.coerce.number().int().min(0).max(999).nullable().optional(),
}).strict();
export const liveMatchSnapshotV1Schema = z.object({
  schema_version: z.literal(1),
  snapshot_revision: z.coerce.number().int().min(0).max(2_147_483_647),
  captured_at: z.string().datetime({ offset: true }),
  state: z.enum(["waiting", "live", "paused", "ended"]),
  map_name: z.string().trim().max(128).optional().default(""),
  round_number: z.coerce.number().int().min(0).max(500).nullable().optional(),
  score_t: z.coerce.number().int().min(0).max(500).nullable().optional(),
  score_ct: z.coerce.number().int().min(0).max(500).nullable().optional(),
  terrorist_players: z.array(liveMatchPlayerSchema).max(16).default([]),
  counter_terrorist_players: z.array(liveMatchPlayerSchema).max(16).default([]),
  spectator_players: z.array(liveMatchPlayerSchema).max(64).default([]),
}).strict();
const matchCoreEventTypeSchema = z.enum(["match_created", "state_transition", "player_disconnected", "player_returned", "fill_assigned", "fill_removed", "snapshot_saved", "result_final", "match_cancelled"]);
const matchCoreEventSchema = z.object({
  event_id: pluginEventIdSchema,
  event: matchCoreEventTypeSchema.optional(),
  event_type: matchCoreEventTypeSchema.optional(),
  match_id: z.string().uuid().optional(),
}).passthrough().superRefine((input, context) => {
  if (!input.event && !input.event_type) context.addIssue({ code: z.ZodIssueCode.custom, message: "event or event_type is required", path: ["event_type"] });
  if (input.event && input.event_type && input.event !== input.event_type) context.addIssue({ code: z.ZodIssueCode.custom, message: "event and event_type must match", path: ["event_type"] });
});
const userIdSchema = z.string().uuid();
const penaltyTypeSchema = z.enum(["ban", "comm", "gag"]);
const staffPanelServerSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const staffPanelMapSchema = z.enum(["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"]);
const staffPanelActionSchema = z.object({
  serverId: staffPanelServerSchema,
  type: z.enum(["ban", "unban", "kick", "mute", "rename", "map_change", "server_announcement", "match_announcement", "hud_announcement", "player_hud_alert", "player_message", "restart_all", "restart_server", "start_server", "stop_server", "timeout", "unpause", "round_restart", "round_restore", "player_ip_lookup"]),
  playerSteamId: z.string().regex(/^\d{17}$/).optional(),
  playerName: z.string().trim().min(1).max(64).optional(),
  map: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_/-]+$/).optional(),
  message: z.string().trim().min(1).max(240).optional(),
  durationSeconds: z.number().int().min(1).max(86_400).optional(),
  reason: z.string().trim().min(1).max(240).optional(),
  banTerm: z.enum(["10m", "30m", "1h", "1d", "7d", "permanent"]).optional(),
  enforceAfterSeconds: z.number().int().min(0).max(60).optional(),
  alertColor: z.enum(["gold", "sky", "red", "green", "neutral"]).optional(),
  countdownSeconds: z.number().int().min(0).max(600).optional(),
  newName: z.string().trim().min(2).max(64).optional(),
  mapImpactAcknowledged: z.literal(true).optional(),
}).strict().superRefine((input, context) => {
  const playerActions = new Set(["ban", "unban", "kick", "mute", "rename", "player_hud_alert", "player_message", "player_ip_lookup"]);
  const messageActions = new Set(["ban", "unban", "kick", "mute", "server_announcement", "match_announcement", "hud_announcement", "player_hud_alert", "player_message", "timeout"]);
  if (playerActions.has(input.type) && !input.playerSteamId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSteamId"], message: "A 17-digit SteamID is required for this action" });
  }
  if (input.type === "map_change") {
    if (!input.map) context.addIssue({ code: z.ZodIssueCode.custom, path: ["map"], message: "A map is required for a map change" });
    else if (!staffPanelMapSchema.safeParse(input.map).success) context.addIssue({ code: z.ZodIssueCode.custom, path: ["map"], message: "The selected map is not approved for staff map control" });
    if (input.mapImpactAcknowledged !== true) context.addIssue({ code: z.ZodIssueCode.custom, path: ["mapImpactAcknowledged"], message: "Map change impact acknowledgement is required" });
  }
  if (messageActions.has(input.type) && !input.message) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["message"], message: "A reason or announcement is required for this action" });
  }
  if (input.type === "ban" && !input.banTerm) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["banTerm"], message: "A ban term is required" });
  }
  if (input.type === "ban" && input.enforceAfterSeconds !== 10) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["enforceAfterSeconds"], message: "Ban enforcement must use the approved 10 second player notice" });
  }
  if (input.type === "rename" && !input.newName) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["newName"], message: "A new player name is required" });
  }
  if (input.type === "timeout" && !input.durationSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["durationSeconds"], message: "A timeout duration is required" });
  }
});
const skinchangerCategorySchema = z.enum(["weapon", "weapon_skin", "knife", "glove", "agent", "music_kit", "pin", "sticker", "charm"]);
const skinchangerSlotSchema = z.enum(["weapon", "knife", "glove", "agent", "music_kit", "pin"]);
const skinchangerTeamScopeSchema = z.enum(["all", "t", "ct"]);
const skinchangerStickerSchema = z.object({
  catalogItemId: z.string().uuid(),
  id: z.number().int().positive().optional(),
  slot: z.number().int().min(0).max(4),
  schema: z.number().int().min(0).max(1).optional(),
  offsetX: z.number().min(-1).max(1).optional(),
  offsetY: z.number().min(-1).max(1).optional(),
  wear: z.number().min(0).max(1).optional(),
  scale: z.number().min(0.1).max(3).optional(),
  rotation: z.number().min(-360).max(360).optional(),
}).strict();
const skinchangerCharmSchema = z.object({
  catalogItemId: z.string().uuid(),
  id: z.number().int().positive().optional(),
  offsetX: z.number().min(-1).max(1).optional(),
  offsetY: z.number().min(-1).max(1).optional(),
  offsetZ: z.number().min(-1).max(1).optional(),
  seed: z.number().int().min(0).max(1_000).optional(),
}).strict();
const skinchangerLoadoutEntrySchema = z.object({
  slot: skinchangerSlotSchema,
  slotKey: z.string().regex(/^[a-z0-9:_-]{1,96}$/),
  teamScope: skinchangerTeamScopeSchema.default("all"),
  catalogItemId: z.string().uuid(),
  options: z.object({
    wear: z.number().min(0).max(1).optional(),
    seed: z.number().int().min(0).max(1_000).optional(),
    statTrak: z.boolean().optional(),
    nameTag: z.string().trim().min(1).max(32).optional(),
    stickers: z.array(skinchangerStickerSchema).max(5).optional(),
    charm: skinchangerCharmSchema.optional(),
  }).strict().default({}),
}).superRefine((entry, context) => {
  const occupied = new Set<number>();
  for (const sticker of entry.options.stickers ?? []) {
    if (occupied.has(sticker.slot)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["options", "stickers"], message: "Sticker slots must be unique" });
    occupied.add(sticker.slot);
  }
  if (entry.slot !== "weapon" && ((entry.options.stickers?.length ?? 0) > 0 || entry.options.charm)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "Only weapons can be customised with stickers or charms" });
  }
});
// An empty entry list is the intentional, confirmed action for removing the
// final saved look. The database RPC then advances the version and clears rows.
const skinchangerLoadoutSchema = z.object({ entries: z.array(skinchangerLoadoutEntrySchema).max(128) });
const skinchangerEntryMutationSchema = z.object({
  expectedVersion: z.number().int().min(0),
  entry: skinchangerLoadoutEntrySchema,
});
const skinchangerEntryRemovalSchema = z.object({
  expectedVersion: z.number().int().min(0),
  slotKey: z.string().regex(/^[a-z0-9:_-]{1,96}$/),
  teamScope: skinchangerTeamScopeSchema,
});
type DbRow = Record<string, any>;

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function recordValue(value: unknown): DbRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DbRow : {};
}

const tOnlyFirearms = new Set(["AK-47", "Galil AR", "SG 553", "G3SG1", "Glock-18", "Tec-9", "MAC-10", "Sawed-Off"]);
const ctOnlyFirearms = new Set(["AUG", "FAMAS", "M4A1-S", "M4A4", "SCAR-20", "USP-S", "P2000", "Five-SeveN", "MP9", "MAG-7"]);

function catalogTeamScope(metadata: unknown, weaponClass: unknown, displayName: unknown): "all" | "t" | "ct" {
  const team = textValue(recordValue(metadata).team).toLowerCase();
  if (team === "ct" || (team.includes("counter") && !team.includes("terrorist"))) return "ct";
  if (team === "t" || (team.includes("terrorist") && !team.includes("counter"))) return "t";
  const firearmName = textValue(weaponClass) || textValue(displayName);
  if (ctOnlyFirearms.has(firearmName)) return "ct";
  if (tOnlyFirearms.has(firearmName)) return "t";
  return "all";
}

function timestampValue(value: unknown) {
  return value == null ? "" : String(value);
}

function firstRow(value: unknown): DbRow | null {
  if (Array.isArray(value)) return (value[0] as DbRow | undefined) ?? null;
  return value && typeof value === "object" ? value as DbRow : null;
}

function mapUserProfile(user: DbRow, links: DbRow[] = []) {
  const profile: Record<string, unknown> = {
    id: textValue(user.id),
    steamId: textValue(user.steam_id),
    username: textValue(user.username),
    avatar: textValue(user.avatar),
    level: numberValue(user.level),
    rank: textValue(user.rank),
  };
  if (user.faceit_username && user.faceit_elo != null && user.faceit_level != null) {
    profile.faceit = { username: textValue(user.faceit_username), elo: numberValue(user.faceit_elo), level: numberValue(user.faceit_level) };
  }
  profile.links = links.map(link => ({ url: textValue(link.url) }));
  profile.hiddenSections = hiddenSectionsValue(user.hidden_profile_sections);
  if ("notification_prefs" in user) profile.notificationPrefs = notificationPrefsValue(user.notification_prefs);
  return profile;
}

function mapProfileStats(stats: DbRow) {
  return { matches: numberValue(stats.matches), wins: numberValue(stats.wins), kdRatio: numberValue(stats.kd_ratio), rating: numberValue(stats.rating) };
}

type ModerationStatus = "Banned" | "Muted" | "Clear";

function mapPenalty(penalty: DbRow, adminProfiles: Map<string, { steamId: string; avatar: string }> = new Map(), moderationStatuses: Map<string, ModerationStatus> = new Map()) {
  const user = firstRow(penalty.users) ?? {};
  const admin = textValue(penalty.admin_name);
  const issuer = adminProfiles.get(admin);
  const userId = textValue(user.id || penalty.user_id);
  return { id: textValue(penalty.id), type: textValue(penalty.type), player: textValue(user.username), playerSteamId: textValue(user.steam_id) || undefined, avatar: textValue(user.avatar), moderationStatus: moderationStatuses.get(userId) ?? "Clear", reason: textValue(penalty.reason), term: textValue(penalty.term), isPermanent: Boolean(penalty.is_permanent), isUnbanned: Boolean(penalty.is_unbanned), admin, adminSteamId: issuer?.steamId || undefined, adminAvatar: issuer?.avatar || undefined, expiresAt: timestampValue(penalty.expires_at) || null, date: timestampValue(penalty.created_at) };
}

function activePenaltyStatus(penalty: DbRow): ModerationStatus | undefined {
  if (Boolean(penalty.is_unbanned)) return undefined;
  const expiresAt = timestampValue(penalty.expires_at);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return undefined;
  const type = textValue(penalty.type).toLowerCase();
  if (type === "ban") return "Banned";
  if (type === "comm" || type === "gag") return "Muted";
  return undefined;
}

async function resolveModerationStatuses(userIds: string[], database: ReturnType<typeof legacyXDb>) {
  const uniqueUserIds = userIds.filter((userId, index, values) => Boolean(userId) && values.indexOf(userId) === index);
  const statuses = new Map<string, ModerationStatus>();
  if (uniqueUserIds.length === 0) return statuses;
  const { data, error } = await database.from("penalties").select("user_id,type,is_unbanned,expires_at").in("user_id", uniqueUserIds).eq("is_unbanned", false);
  legacyXError(error, "Unable to resolve player moderation statuses");
  for (const penalty of (data ?? []) as DbRow[]) {
    const status = activePenaltyStatus(penalty);
    const userId = textValue(penalty.user_id);
    if (!status || !userId) continue;
    if (status === "Banned" || !statuses.has(userId)) statuses.set(userId, status);
  }
  return statuses;
}

function mapNotification(notification: DbRow) {
  return {
    id: textValue(notification.id),
    kind: textValue(notification.kind),
    title: textValue(notification.title),
    body: notification.body == null ? null : textValue(notification.body),
    metadata: recordValue(notification.metadata),
    readAt: timestampValue(notification.read_at) || null,
    createdAt: timestampValue(notification.created_at),
  };
}

async function mapPenaltiesWithProfileIdentities(rows: DbRow[], database: ReturnType<typeof legacyXDb>) {
  const adminNames = Array.from(new Set(rows.map(row => textValue(row.admin_name)).filter(Boolean)));
  const adminProfiles = new Map<string, { steamId: string; avatar: string }>();
  if (adminNames.length) {
    const { data, error } = await database.from("users").select("username,steam_id,avatar").in("username", adminNames);
    legacyXError(error, "Unable to resolve penalty issuer profiles");
    for (const user of (data ?? []) as DbRow[]) adminProfiles.set(textValue(user.username), { steamId: textValue(user.steam_id), avatar: textValue(user.avatar) });
  }
  const moderationStatuses = await resolveModerationStatuses(rows.map(row => textValue(row.user_id)), database);
  return rows.map(row => mapPenalty(row, adminProfiles, moderationStatuses));
}

function mapFeedback(feedback: DbRow, reviewerProfiles: Map<string, { steamId: string; avatar: string }> = new Map()) {
  const userId = textValue(feedback.user_id);
  const reviewer = reviewerProfiles.get(userId);
  return { id: textValue(feedback.id), steamId: reviewer?.steamId || undefined, avatar: reviewer?.avatar || undefined, name: textValue(feedback.name), rating: numberValue(feedback.rating), message: textValue(feedback.message), date: timestampValue(feedback.created_at) };
}

function noBody(req: Request) {
  if (req.body && Object.keys(req.body).length > 0) apiError(400, "This endpoint does not accept a request body");
}

function deferredFeatureForRequest(req: Request): DeferredFeatureKey | null {
  const path = req.path;
  if (path.startsWith("/staffpanel")) return "staffPanel";
  if (path.startsWith("/auth/steam") && String(req.query.staffpanel ?? "") === "1") return "staffPanel";
  return null;
}

/** Play page bucket for a server's LEGACYX_SERVER_MODE (e.g. competitive_5v5, pro_league, fun_retake). */
export function serverModeKind(mode: string): "5v5" | "pro" | "fun" | "other" {
  const value = mode.trim().toLowerCase();
  if (/pro/.test(value)) return "pro";
  if (/fun|retake|dm|deathmatch|surf|aim|arena|casual/.test(value)) return "fun";
  if (/5v5|5vs5|competitive/.test(value)) return "5v5";
  return "other";
}

export function createLegacyXRouter() {
  const router = Router();
  const db = () => legacyXDb();
  const mapFeedbackRows = async (rows: DbRow[]) => {
    const userIds = rows.map(row => textValue(row.user_id)).filter((userId, index, values) => Boolean(userId) && values.indexOf(userId) === index);
    if (userIds.length === 0) return rows.map(row => mapFeedback(row));
    const { data, error } = await db().from("users").select("id,steam_id,avatar").in("id", userIds);
    legacyXError(error, "Unable to resolve feedback reviewer profiles");
    const reviewerProfiles = new Map(((data ?? []) as DbRow[]).map(user => [textValue(user.id), { steamId: textValue(user.steam_id), avatar: textValue(user.avatar) }]));
    return rows.map(row => mapFeedback(row, reviewerProfiles));
  };

  router.use(rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : apiRateLimitMax(),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please retry shortly." },
  }));
  const authRateLimit = rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : apiAuthRateLimitMax(),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many authentication requests. Please retry shortly." },
  });
  const sensitiveMutationRateLimit = rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : apiSensitiveRateLimitMax(),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sensitive requests. Please retry shortly." },
  });
  router.use("/auth", authRateLimit);
  router.use("/staff", sensitiveMutationRateLimit);
  router.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    const frontendOrigin = process.env.FRONTEND_ORIGIN?.trim().replace(/\/$/, "");
    const origin = req.header("origin");
    if (frontendOrigin && origin === frontendOrigin) {
      res.setHeader("Access-Control-Allow-Origin", frontendOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    if (req.method === "OPTIONS") return res.sendStatus(403);
    next();
  });
  router.get("/public/features", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ features: publicDeferredFeatureFlags() });
  });
  router.use((req, _res, next) => {
    const feature = deferredFeatureForRequest(req);
    if (feature && !isDeferredFeatureEnabled(feature)) {
      return next(Object.assign(new Error("This feature is not currently available"), { statusCode: 404 }));
    }
    next();
  });
  router.use(createAdminRouter());
  router.use(createTournamentRouter());

  const resolveUserId = async (rawIdentity: string, caller: LegacyUser) => {
    if (rawIdentity === "me") return caller.id;
    if (/^\d{15,20}$/.test(rawIdentity)) {
      const { data, error } = await db().from("users").select("id").eq("steam_id", rawIdentity).maybeSingle();
      legacyXError(error, "Unable to resolve SteamID64 profile");
      if (!data) apiError(404, "Player was not found");
      return textValue(data.id);
    }
    return userIdSchema.parse(rawIdentity);
  };
  const profileColumns = "id,steam_id,username,avatar,level,rank,faceit_username,faceit_elo,faceit_level,player_stats(*)";
  const loadProfile = async (id: string) => {
    const [firstUserResult, linksResult] = await Promise.all([
      db().from("users").select(`${profileColumns},hidden_profile_sections,notification_prefs`).eq("id", id).maybeSingle(),
      db().from("user_links").select("url").eq("user_id", id).order("created_at"),
    ]);
    // Until legacy_x_profile_privacy.sql is applied the column is missing; profiles then have nothing hidden.
    const userResult = isMissingColumnError(firstUserResult.error)
      ? await db().from("users").select(profileColumns).eq("id", id).maybeSingle()
      : firstUserResult;
    legacyXError(userResult.error || linksResult.error, "Unable to load profile");
    if (!userResult.data) apiError(404, "Player was not found");
    return { user: userResult.data as DbRow, links: (linksResult.data ?? []) as DbRow[] };
  };
  /** Sections the player hid; the owner always sees everything on their own profile. */
  const hiddenSectionsFor = async (userId: string, viewerId: string) => {
    if (userId === viewerId) return [] as ProfileHideableSection[];
    const { data, error } = await db().from("users").select("hidden_profile_sections").eq("id", userId).maybeSingle();
    if (isMissingColumnError(error)) return [] as ProfileHideableSection[];
    legacyXError(error, "Unable to load profile privacy");
    return hiddenSectionsValue((data as DbRow | null)?.hidden_profile_sections);
  };
  /** Website role shown on the profile, from the active staff directory entry. */
  const profileRoleFor = async (userId: string) => {
    const { data, error } = await db().from("staff").select("role").eq("user_id", userId).eq("status", "active").maybeSingle();
    if (error) return "Player";
    return STAFF_PROFILE_ROLES[textValue((data as DbRow | null)?.role)] ?? "Player";
  };

  // Public website reads deliberately bypass AdminPlus. CS2 plugins/admin tools
  // write to Supabase; the website reads these safe projections through root API.
  // Leaders shows the whole community, not a top slice, so its ladder is allowed to be long.
  const readLadderLimit = (value: unknown) => z.coerce.number().int().min(1).max(1000).default(500).parse(value);
  const readServers = async () => {
    const full = await db().from("reconnect_servers").select("server_id,connect_address,display_name,current_map,current_mode,player_count,last_heartbeat_at,max_players,gotv_address").order("display_name").limit(100);
    // Before legacy_x_reconnect_server_capacity.sql the capacity columns are missing; fall back to the base columns.
    const result = isMissingColumnError(full.error)
      ? await db().from("reconnect_servers").select("server_id,connect_address,display_name,current_map,current_mode,player_count,last_heartbeat_at").order("display_name").limit(100)
      : full;
    legacyXError(result.error, "Unable to load public servers");
    // Fresh live snapshots (same 90s window as the live-match route) give the cards their state, score and round.
    const snapshots = await db().schema("legacy_x").from("server_live_match_snapshots").select("server_id,state,round_number,score_t,score_ct,reported_at");
    const liveByServer = new Map<string, { state: string; round: number | null; score: { t: number; ct: number } | null }>();
    for (const row of (snapshots.error ? [] : snapshots.data ?? []) as DbRow[]) {
      const reportedAt = Date.parse(textValue(row.reported_at));
      if (!Number.isFinite(reportedAt) || Date.now() - reportedAt > 90_000) continue;
      const t = typeof row.score_t === "number" ? row.score_t : null;
      const ct = typeof row.score_ct === "number" ? row.score_ct : null;
      liveByServer.set(textValue(row.server_id), { state: textValue(row.state), round: typeof row.round_number === "number" ? row.round_number : null, score: t !== null && ct !== null ? { t, ct } : null });
    }
    return ((result.data ?? []) as DbRow[]).map(server => {
      const heartbeat = new Date(String(server.last_heartbeat_at ?? "")).getTime();
      const players = numberValue(server.player_count);
      const mode = serverModeKind(textValue(server.current_mode));
      const maxPlayers = numberValue(server.max_players) || (mode === "fun" ? 16 : 10);
      const online = Number.isFinite(heartbeat) && Date.now() - heartbeat <= 90_000;
      return { id: textValue(server.server_id), name: textValue(server.display_name) || textValue(server.server_id), map: textValue(server.current_map) || "Unknown", players, maxPlayers, mode, rawMode: textValue(server.current_mode) || null, ping: 0, status: online ? (players >= maxPlayers ? "full" : "online") : "offline", connectAddress: textValue(server.connect_address), gotvAddress: textValue(server.gotv_address) || null, lastHeartbeatAt: textValue(server.last_heartbeat_at) || null, live: online ? liveByServer.get(textValue(server.server_id)) ?? null : null };
    });
  };
  const ingestLiveMatchSnapshot = async (pluginId: string, eventId: string, serverId: string, snapshot: z.infer<typeof liveMatchSnapshotV1Schema>) => {
    const { data, error } = await db().schema("legacy_x").rpc("ingest_server_live_match_snapshot", {
      p_plugin_id: pluginId,
      p_event_id: eventId,
      p_server_id: serverId,
      p_payload: snapshot,
    });
    legacyXError(error, "Unable to ingest live server match snapshot");
    return data ?? {};
  };
  const leaderboardColumns = "position,user_id,steam_id,username,avatar,current_exp,rank_id,rank_slug,rank_name,rank_image_key,pro_league_unlocked,matches_completed,wins,losses,kills,assists,headshot_kills,deaths,kd_ratio,win_rate,played_hours,last_match_at";
  /** K/D and win rate only rank players with at least this many completed matches (EXP ranks everyone). */
  const RATIO_LADDER_MIN_MATCHES = 10;
  const leaderboardSortSchema = z.enum(["exp", "kd", "win"]).default("exp");
  const leaderboardQuery = (sort: z.infer<typeof leaderboardSortSchema>) => {
    let query = db().from("competitive_leaderboard").select(leaderboardColumns);
    if (sort === "exp") return query.order("position");
    query = query.gte("matches_completed", RATIO_LADDER_MIN_MATCHES);
    const column = sort === "kd" ? "kd_ratio" : "win_rate";
    return query.order(column, { ascending: false }).order("matches_completed", { ascending: false }).order("position");
  };
  router.get("/public/competitive/leaderboard", optionalUserRoute(async (req, res, viewer) => {
    const sort = leaderboardSortSchema.parse(req.query.sort || undefined);
    const search = z.string().trim().max(64).optional().parse(req.query.q || undefined);
    const limit = readLadderLimit(req.query.limit);
    // Positions always come from the full ladder for the active sort, so a search result keeps its real place.
    const { data, error } = await leaderboardQuery(sort).limit(sort === "exp" && !search ? limit : 5000);
    legacyXError(error, "Unable to load competitive leaderboard");
    const ladder: DbRow[] = ((data ?? []) as DbRow[]).map((row, index): DbRow => ({ ...row, position: sort === "exp" ? numberValue(row.position) ?? index + 1 : index + 1 }));
    const needle = search?.toLowerCase();
    const entries = needle
      ? ladder.filter(row => textValue(row.username).toLowerCase().includes(needle) || textValue(row.steam_id) === search).slice(0, limit)
      : ladder.slice(0, limit);
    let viewerEntry: DbRow | null = viewer ? ladder.find(row => textValue(row.user_id) === viewer.id) ?? null : null;
    if (viewer && !viewerEntry && sort === "exp") {
      const own = await db().from("competitive_leaderboard").select(leaderboardColumns).eq("user_id", viewer.id).maybeSingle();
      legacyXError(own.error, "Unable to load your leaderboard position");
      viewerEntry = (own.data as DbRow | null) ?? null;
    }
    res.json({ sort, minimumMatches: sort === "exp" ? 0 : RATIO_LADDER_MIN_MATCHES, entries, viewer: viewerEntry });
  }));
  router.get("/public/servers/:serverId/live-match", asyncRoute(async (req, res) => {
    const serverId = z.string().trim().min(1).max(120).parse(req.params.serverId);
    const [serverResult, snapshotResult, sessionsResult] = await Promise.all([
      db().schema("legacy_x").from("reconnect_servers").select("server_id,display_name,current_map,current_mode,player_count,last_heartbeat_at").eq("server_id", serverId).maybeSingle(),
      db().schema("legacy_x").from("server_live_match_snapshots").select("state,map_name,round_number,score_t,score_ct,terrorist_players,counter_terrorist_players,spectator_players,schema_version,snapshot_revision,captured_at,reported_at").eq("server_id", serverId).maybeSingle(),
      db().schema("legacy_x").from("reconnect_sessions").select("steam_id,player_name,connected_at").eq("server_id", serverId).is("disconnected_at", null).order("connected_at").limit(32),
    ]);
    legacyXError(serverResult.error || snapshotResult.error || sessionsResult.error, "Unable to load live server match");
    if (!serverResult.data) apiError(404, "Server was not found");

    const snapshot = snapshotResult.data as DbRow | null;
    const rosterOnly = ((sessionsResult.data ?? []) as DbRow[]).map(session => ({ steamId: textValue(session.steam_id), name: textValue(session.player_name) || "Unknown player", connected: true }));
    const normalizePlayers = (value: unknown) => z.array(liveMatchPlayerSchema).safeParse(value).success
      ? z.array(liveMatchPlayerSchema).parse(value).map(player => ({
        steamId: player.steam_id,
        name: player.name,
        connected: player.connected,
        rankId: player.rank_id ?? null,
        rankName: player.rank_name ?? null,
        rankImageKey: player.rank_image_key ?? null,
        adr: player.adr ?? null,
        ping: player.ping ?? null,
        kills: player.kills ?? null,
        deaths: player.deaths ?? null,
        assists: player.assists ?? null,
      }))
      : [];
    const nullableNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
    const reportedAt = textValue(snapshot?.reported_at);
    const reportedAtMs = Date.parse(reportedAt);
    // A stale snapshot must not surface an old score or old team assignment.
    // The connected-player fallback remains available while a plugin catches up.
    const hasSnapshot = Boolean(snapshot) && Number.isFinite(reportedAtMs) && Date.now() - reportedAtMs <= 90_000;
    const scoreT = nullableNumber(snapshot?.score_t);
    const scoreCt = nullableNumber(snapshot?.score_ct);
    res.json({
      liveMatch: {
        serverId,
        serverName: textValue(serverResult.data.display_name) || serverId,
        map: textValue(snapshot?.map_name) || textValue(serverResult.data.current_map) || "Unknown",
        mode: textValue(serverResult.data.current_mode) || "Community",
        state: hasSnapshot ? textValue(snapshot?.state) : "unavailable",
        round: hasSnapshot ? nullableNumber(snapshot?.round_number) : null,
        score: hasSnapshot && scoreT !== null && scoreCt !== null ? { t: scoreT, ct: scoreCt } : null,
        teams: hasSnapshot ? { t: normalizePlayers(snapshot?.terrorist_players), ct: normalizePlayers(snapshot?.counter_terrorist_players) } : { t: [], ct: [] },
        spectators: hasSnapshot ? normalizePlayers(snapshot?.spectator_players) : [],
        connectedPlayers: hasSnapshot ? [] : rosterOnly,
        updatedAt: hasSnapshot ? reportedAt : textValue(serverResult.data.last_heartbeat_at) || null,
        availability: hasSnapshot ? "live_snapshot" : rosterOnly.length > 0 ? "roster_only" : "unavailable",
      },
    });
  }));
  const competitiveProfileColumns = "user_id,steam_id,username,avatar,current_exp,rank_id,rank_slug,rank_name,rank_image_key,pro_league_unlocked,matches_completed,wins,losses,kills,deaths,assists,headshot_kills,last_match_at,current_rank_min_exp,next_rank_id,next_rank_name,next_rank_min_exp";
  router.get("/public/competitive/players/:userId", asyncRoute(async (req, res) => {
    const userId = userIdSchema.parse(req.params.userId);
    const [{ data, error }, position] = await Promise.all([
      db().from("competitive_player_profiles").select(competitiveProfileColumns).eq("user_id", userId).maybeSingle(),
      db().from("competitive_leaderboard").select("position").eq("user_id", userId).maybeSingle(),
    ]);
    legacyXError(error || position.error, "Unable to load competitive player profile");
    if (data) {
      res.json({ profile: { ...data, leaderboard_position: numberValue((position.data as DbRow | null)?.position) } });
      return;
    }
    // The views cover every user; reaching this means the user does not exist.
    const { data: user, error: userError } = await db().from("users").select("id,steam_id,username,avatar").eq("id", userId).maybeSingle();
    legacyXError(userError, "Unable to load competitive player");
    if (!user) apiError(404, "Competitive player profile was not found");
    const progress = rankProgress(STARTING_EXP);
    res.json({ profile: {
      user_id: user.id,
      steam_id: user.steam_id,
      username: user.username,
      avatar: user.avatar,
      current_exp: progress.exp,
      rank_id: progress.rank.id,
      rank_slug: progress.rank.slug,
      rank_name: progress.rank.name,
      rank_image_key: progress.rank.imageKey,
      pro_league_unlocked: false,
      matches_completed: 0,
      wins: 0,
      losses: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      headshot_kills: 0,
      last_match_at: null,
      current_rank_min_exp: progress.rank.minimumExp,
      next_rank_id: progress.next?.id ?? null,
      next_rank_name: progress.next?.name ?? null,
      next_rank_min_exp: progress.next?.minimumExp ?? null,
      leaderboard_position: null,
    } });
  }));
  /** Ranked match history with the EXP change and its breakdown (RANK-SYSTEM.md section 6). */
  router.get("/public/competitive/players/:userId/matches", optionalUserRoute(async (req, res, viewer) => {
    const userId = userIdSchema.parse(req.params.userId);
    const limit = z.coerce.number().int().min(1).max(50).default(20).parse(req.query.limit || undefined);
    if (!viewer || viewer.id !== userId) {
      const hidden = await db().from("users").select("hidden_profile_sections").eq("id", userId).maybeSingle();
      if (!isMissingColumnError(hidden.error)) legacyXError(hidden.error, "Unable to load profile privacy");
      if (hiddenSectionsValue((hidden.data as DbRow | null)?.hidden_profile_sections).includes("recent_matches")) {
        res.json({ entries: [], hidden: true });
        return;
      }
    }
    const { data, error } = await db().from("competitive_match_exp")
      .select("event_id,match_id,team_key,outcome,exp_before,exp_delta,exp_after,rank_before,rank_after,exp_breakdown,counts_as_ranked,calculation_version,stats,created_at,core_matches(map_name,result,finished_at)")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
    legacyXError(error, "Unable to load ranked match history");
    res.json({ hidden: false, entries: ((data ?? []) as DbRow[]).map(mapCompetitiveMatch) });
  }));
  /** One ranked match: map, score, both rosters with K/D/A and each player's EXP change. */
  router.get("/public/ranked-matches/:matchId", asyncRoute(async (req, res) => {
    const matchId = z.string().uuid().parse(req.params.matchId);
    const [matchResult, rowsResult] = await Promise.all([
      db().from("core_matches").select("id,map_name,map_number,matchzy_local_id,state,result,started_at,finished_at").eq("id", matchId).maybeSingle(),
      db().from("competitive_match_exp").select("user_id,team_key,outcome,exp_before,exp_delta,exp_after,rank_after,exp_breakdown,counts_as_ranked,stats,created_at,users(id,steam_id,username,avatar,hidden_profile_sections)").eq("match_id", matchId),
    ]);
    legacyXError(matchResult.error || rowsResult.error, "Unable to load ranked match");
    if (!matchResult.data) apiError(404, "Match was not found");
    const match = matchResult.data as DbRow;
    const competitive = recordValue(recordValue(match.result).competitive_result);
    // The round timeline is optional: it exists only for matches whose MatchZy round_end events were recorded.
    const localId = textValue(match.matchzy_local_id);
    const rounds = localId
      ? await db().from("match_rounds").select("round_number,winner_side,reason,team1_score,team2_score").eq("match_external_id", localId).eq("map_number", numberValue(match.map_number) ?? 0).order("round_number")
      : { data: [], error: null };
    if (rounds.error) console.warn("[legacy-x-api] match rounds unavailable", rounds.error.message);
    const rows = (rowsResult.data ?? []) as DbRow[];
    const team = (key: "team1" | "team2") => ({
      key,
      roundsWon: numberValue(recordValue(competitive[key]).rounds_won),
      players: rows.filter(row => textValue(row.team_key) === key).map(row => {
        const user = recordValue(row.users);
        const stats = recordValue(row.stats);
        const hidesMatches = hiddenSectionsValue(user.hidden_profile_sections).includes("recent_matches");
        const breakdown = recordValue(row.exp_breakdown);
        return {
          userId: textValue(user.id),
          steamId: textValue(user.steam_id),
          name: textValue(user.username),
          avatar: textValue(user.avatar),
          kills: hidesMatches ? null : numberValue(stats.kills),
          deaths: hidesMatches ? null : numberValue(stats.deaths),
          assists: hidesMatches ? null : numberValue(stats.assists),
          expDelta: numberValue(row.exp_delta),
          expAfter: numberValue(row.exp_after),
          rankId: numberValue(row.rank_after),
          reason: textValue(breakdown.reason) || "ranked",
        };
      }).sort((a, b) => (b.expDelta ?? 0) - (a.expDelta ?? 0)),
    });
    res.json({
      matchId,
      map: textValue(match.map_name),
      state: textValue(match.state),
      startedAt: textValue(match.started_at) || null,
      finishedAt: textValue(match.finished_at) || null,
      mode: textValue(competitive.mode) || null,
      totalRounds: numberValue(competitive.total_rounds),
      teams: [team("team1"), team("team2")],
      rounds: rounds.error ? [] : mapMatchRounds((rounds.data ?? []) as DbRow[]),
    });
  }));
  router.get("/public/servers", asyncRoute(async (_req, res) => {
    res.json({ entries: await readServers() });
  }));
  router.get("/public/servers/:serverId", asyncRoute(async (req, res) => {
    const serverId = String(req.params.serverId || "").trim();
    const server = (await readServers()).find(entry => entry.id === serverId);
    if (!server) apiError(404, "Server not found");
    res.json({ server });
  }));
  /** Records a player's intent to join a live server (the connect itself goes through steam://connect). */
  router.post("/public/servers/:serverId/join", optionalUserRoute(async (req, res, user) => {
    noBody(req);
    const serverId = z.string().trim().min(1).max(120).parse(req.params.serverId);
    const server = (await readServers()).find(entry => entry.id === serverId);
    if (!server) apiError(404, "Server was not found");
    if (server.status !== "online" || !server.connectAddress) apiError(409, "Server is not currently joinable");
    if (user) {
      const { error } = await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "server.join", target_type: "reconnect_servers", metadata: { serverId, map: server.map, mode: server.mode } });
      legacyXError(error, "Unable to record server join");
    }
    res.status(204).end();
  }));
  router.get("/public/killfeed", asyncRoute(async (req, res) => {
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after || undefined);
    res.setHeader("Cache-Control", "no-store");
    res.json(killFeed.since(after));
  }));
  /**
   * Quick join: 5x5 / Pro prefer the joinable server with the most players (closest to starting), then the
   * viewer's favourite maps; Fun picks the busiest server with a free slot.
   */
  router.get("/play/:mode/quick-join", asyncRoute(async (req, res) => {
    const mode = z.enum(["5v5", "fun", "pro"]).parse(req.params.mode);
    const favouriteMaps = z.string().max(400).optional().parse(req.query.maps || undefined)?.split(",").map(map => map.trim()).filter(Boolean) ?? [];
    const joinable = (await readServers()).filter(server => server.mode === mode && server.status === "online" && server.players < server.maxPlayers && server.connectAddress);
    joinable.sort((a, b) => b.players - a.players || Number(favouriteMaps.includes(b.map)) - Number(favouriteMaps.includes(a.map)) || a.name.localeCompare(b.name));
    const server = joinable[0] ?? null;
    res.json({ server, connectAddress: server?.connectAddress ?? null });
  }));
  router.get("/public/overview", asyncRoute(async (_req, res) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [servers, matches] = await Promise.all([
      readServers(),
      db().from("core_match_history").select("match_id").gte("started_at", today.toISOString()).limit(1_000),
    ]);
    legacyXError(matches.error, "Unable to load public overview");
    const online = servers.filter(server => server.status !== "offline");
    res.json({ playersOnline: online.reduce((total, server) => total + server.players, 0), liveServers: online.length, matchesToday: (matches.data ?? []).length });
  }));

  // Frontend contract: every route below is mounted by server/_core/index.ts under /api/v1.
  router.post("/auth/logout", userRoute(async (req, res, user) => {
    noBody(req);
    const refreshToken = parseCookieHeader(req.headers.cookie ?? "").legacyx_refresh_token;
    if (refreshToken) await revokeRefreshSession(refreshToken);
    else await revokeUserRefreshSessions(user.id);
    res.clearCookie("legacyx_access_token", sessionCookieOptions(0));
    res.clearCookie("legacyx_refresh_token", sessionCookieOptions(0));
    res.status(204).end();
  }));
  router.post("/auth/refresh", asyncRoute(async (req, res) => {
    noBody(req);
    const headerToken = req.header("authorization")?.startsWith("Bearer ") ? req.header("authorization")!.slice(7).trim() : undefined;
    const refreshToken = headerToken || parseCookieHeader(req.headers.cookie ?? "").legacyx_refresh_token;
    if (!refreshToken) apiError(401, "Refresh token is required");
    const principal = await rotateRefreshSession(refreshToken);
    const [accessToken, nextRefreshToken, profile] = await Promise.all([issueAccessToken(principal), createRefreshSession(principal.id), loadProfile(principal.id)]);
    res.cookie("legacyx_access_token", accessToken, sessionCookieOptions(15 * 60 * 1000));
    res.cookie("legacyx_refresh_token", nextRefreshToken, sessionCookieOptions(refreshLifetimeMs));
    res.json({ accessToken, refreshToken: nextRefreshToken, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), user: mapUserProfile(profile.user, profile.links) });
  }));
  router.get("/auth/me", userRoute(async (_req, res, user) => {
    const profile = await loadProfile(user.id);
    res.json(mapUserProfile(profile.user, profile.links));
  }));

  // Browser-safe reconnect projection. The SteamID comes only from the
  // verified JWT; a browser never submits an identity or gains plugin access.
  router.get("/reconnect/me", userRoute(async (_req, res, user) => {
    const { data, error } = await db()
      .schema("legacy_x")
      .from("reconnect_last_played")
      .select("session_id,server_id,server_name,connect_address,map_name,mode,disconnected_at,reconnectable_until,player_count,server_online")
      .eq("steam_id", user.steamId)
      .not("disconnected_at", "is", null)
      .eq("server_online", true)
      .gt("reconnectable_until", new Date().toISOString())
      .order("disconnected_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    legacyXError(error, "Unable to load reconnect eligibility");

    const candidate = data as DbRow | null;
    if (!candidate) {
      res.json({ reconnect: null });
      return;
    }

    // A later active session is authoritative evidence the player joined this
    // or another server, so the temporary card must disappear.
    const disconnectedAt = textValue(candidate.disconnected_at);
    const { data: activeSession, error: activeSessionError } = await db()
      .schema("legacy_x")
      .from("reconnect_sessions")
      .select("session_id")
      .eq("steam_id", user.steamId)
      .is("disconnected_at", null)
      .gt("connected_at", disconnectedAt)
      .limit(1)
      .maybeSingle();
    legacyXError(activeSessionError, "Unable to verify reconnect eligibility");
    if (activeSession) {
      res.json({ reconnect: null });
      return;
    }

    // Match Core is the authoritative source for a completed/cancelled 5v5
    // assignment. If its terminal transition happened after this disconnect,
    // the reconnect card must not survive merely because the game server does.
    const { data: terminalCoreMatch, error: terminalCoreMatchError } = await db()
      .schema("legacy_x")
      .from("core_match_participants")
      .select("match_id,core_matches!inner(server_id,state,finished_at,cancelled_at)")
      .eq("steam_id", user.steamId)
      .eq("core_matches.server_id", textValue(candidate.server_id))
      .in("core_matches.state", ["FINISHED", "CANCELLED"])
      .limit(1)
      .maybeSingle();
    legacyXError(terminalCoreMatchError, "Unable to verify terminal Match Core state");
    const terminal = recordValue(recordValue(terminalCoreMatch).core_matches);
    const terminalAt = textValue(terminal.finished_at) || textValue(terminal.cancelled_at);
    if (terminalAt && Date.parse(terminalAt) >= Date.parse(disconnectedAt)) {
      res.json({ reconnect: null });
      return;
    }

    const connectAddress = textValue(candidate.connect_address);
    const addressMatch = /^([a-zA-Z0-9.-]+):(\d{1,5})$/.exec(connectAddress);
    const port = addressMatch ? Number(addressMatch[2]) : 0;
    if (!addressMatch || port < 1 || port > 65_535) {
      // Do not forward malformed data into the Steam URI protocol.
      res.json({ reconnect: null });
      return;
    }

    res.json({ reconnect: {
      sessionId: textValue(candidate.session_id),
      serverId: textValue(candidate.server_id),
      serverName: textValue(candidate.server_name) || textValue(candidate.server_id),
      connectAddress,
      map: textValue(candidate.map_name) || "Unknown",
      mode: textValue(candidate.mode) || "Community",
      disconnectedAt,
      reconnectableUntil: textValue(candidate.reconnectable_until),
      playerCount: numberValue(candidate.player_count),
    } });
  }));

  router.get("/profile/:userId", userRoute(async (req, res, user) => {
    const profile = await loadProfile(await resolveUserId(req.params.userId, user));
    const payload = mapUserProfile(profile.user, profile.links);
    payload.role = await profileRoleFor(textValue(profile.user.id));
    const steamMedia = await resolveSteamProfileMedia(textValue(profile.user.steam_id));
    // steamBackground stays a plain image URL for older frontends; steamMedia adds animated background, avatar and frame.
    payload.steamBackground = steamMedia.background;
    payload.steamMedia = { backgroundVideo: steamMedia.backgroundVideo, animatedAvatar: steamMedia.animatedAvatar, avatarFrame: steamMedia.avatarFrame };
    res.json(payload);
  }));
  router.put("/profile/me", userRoute(async (req, res, user) => {
    const { hiddenSections, notificationPrefs } = profileUpdateSchema.parse(req.body);
    const updates: Record<string, unknown> = {};
    if (hiddenSections) updates.hidden_profile_sections = PROFILE_HIDEABLE_SECTIONS.filter((section) => hiddenSections.includes(section));
    if (notificationPrefs) updates.notification_prefs = { tournaments: notificationPrefs.tournaments, rank_changes: notificationPrefs.rankChanges };
    if (Object.keys(updates).length === 0) apiError(400, "At least one profile field is required");
    const { error } = await db().from("users").update(updates).eq("id", user.id);
    if (isMissingColumnError(error)) apiError(503, "Profile privacy is not available yet");
    legacyXError(error, "Unable to update profile");
    const profile = await loadProfile(user.id);
    const payload = mapUserProfile(profile.user, profile.links);
    payload.role = await profileRoleFor(user.id);
    res.json(payload);
  }));
  router.put("/profile/me/faceit", userRoute(async (req, res, user) => {
    const { nickname } = faceitLinkSchema.parse(req.body);
    const faceit = await resolveFaceitNickname(nickname);
    const { error } = await db()
      .from("users")
      .update({ faceit_username: faceit.nickname, faceit_elo: faceit.elo, faceit_level: faceit.level })
      .eq("id", user.id);
    legacyXError(error, "Unable to link FACEIT profile");
    res.json({ faceit });
  }));
  router.get("/profile/:userId/faceit", userRoute(async (req, res, user) => {
    const profile = await loadProfile(await resolveUserId(req.params.userId, user));
    if ((await hiddenSectionsFor(textValue(profile.user.id), user.id)).includes("faceit")) {
      res.json({ linked: false, hidden: true });
      return;
    }
    const steamId = textValue(profile.user.steam_id);
    try {
      res.json(await getFaceitProfileSnapshotForSteamId(steamId));
      return;
    } catch (error) {
      const statusCode = error && typeof error === "object" && "statusCode" in error ? Number((error as { statusCode?: unknown }).statusCode) : 0;
      if (statusCode !== 404) throw error;
    }
    const nickname = textValue(profile.user.faceit_username);
    if (!nickname) {
      res.json({ linked: false });
      return;
    }
    res.json(await getFaceitProfileSnapshot(nickname));
  }));
  router.get("/profile/:userId/stats", userRoute(async (req, res, user) => {
    const userId = await resolveUserId(req.params.userId, user);
    const { data, error } = await db().from("player_stats").select("matches,wins,kd_ratio,rating").eq("user_id", userId).maybeSingle();
    legacyXError(error, "Unable to load player stats");
    if (!data) apiError(404, "Player stats were not found");
    res.json(mapProfileStats(data as DbRow));
  }));
  router.get("/profile/:userId/matches", userRoute(async (req, res, user) => {
    const userId = await resolveUserId(req.params.userId, user);
    if ((await hiddenSectionsFor(userId, user.id)).includes("recent_matches")) {
      res.json([]);
      return;
    }
    const { data, error } = await db().from("competitive_match_exp")
      .select("event_id,match_id,team_key,outcome,exp_before,exp_delta,exp_after,rank_before,rank_after,exp_breakdown,counts_as_ranked,calculation_version,stats,created_at,core_matches(map_name,result,finished_at)")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(30);
    legacyXError(error, "Unable to load match history");
    res.json(((data ?? []) as DbRow[]).map(mapCompetitiveMatch));
  }));
  router.put("/profile/me/links", userRoute(async (req, res, user) => {
    const input = z.object({ links: z.array(z.object({ url: z.string().url().max(2048) })).max(20) }).parse(req.body);
    const links = input.links.map(link => link.url);
    const { error } = await db().rpc("replace_user_links", { p_user_id: user.id, p_links: links });
    legacyXError(error, "Unable to replace profile links");
    res.json({ links: input.links });
  }));
  router.get("/profile/:userId/penalties", userRoute(async (req, res, user) => {
    const userId = await resolveUserId(req.params.userId, user);
    const { data, error } = await db().from("penalties").select("*,users!penalties_user_id_fkey(username,steam_id,avatar)").eq("user_id", userId).order("created_at", { ascending: false });
    legacyXError(error, "Unable to load penalties");
    res.json(await mapPenaltiesWithProfileIdentities((data ?? []) as DbRow[], db()));
  }));

  router.get("/notifications", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("notifications")
      .select("id,kind,title,body,metadata,read_at,created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    legacyXError(error, "Unable to load notifications");
    const entries = ((data ?? []) as DbRow[]).map(mapNotification);
    res.json({ entries, unreadCount: entries.filter(entry => entry.readAt === null).length });
  }));

  router.post("/notifications/read", userRoute(async (req, res, user) => {
    const input = z.object({ ids: z.array(userIdSchema).max(100).optional() }).parse(req.body ?? {});
    let query = db().from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", user.id).is("read_at", null);
    if (input.ids?.length) query = query.in("id", input.ids);
    const { error } = await query;
    legacyXError(error, "Unable to mark notifications as read");
    res.status(204).end();
  }));

  router.delete("/notifications", userRoute(async (req, res, user) => {
    noBody(req);
    const { error } = await db().from("notifications").delete().eq("user_id", user.id);
    legacyXError(error, "Unable to clear notifications");
    res.status(204).end();
  }));

  router.get("/skinchanger/catalog", userRoute(async (req, res) => {
    const input = z.object({
      category: skinchangerCategorySchema.optional(),
      weaponClass: z.string().trim().min(1).max(64).optional(),
      weaponGroup: z.enum(["Rifles", "Mid Tier", "Pistols"]).optional(),
      team: z.enum(["t", "ct"]).optional(),
      query: z.string().trim().min(1).max(96).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(36),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    if (input.team && input.category !== "agent") apiError(400, "Team selection is only available for agents");
    if (input.weaponGroup && input.category !== "weapon") apiError(400, "Firearm group selection is only available for guns");
    const { data, error } = await db().rpc("get_skinchanger_catalog_page", {
      p_category: input.category ?? null,
      p_weapon_class: input.weaponClass ?? null,
      p_weapon_group: input.weaponGroup ?? null,
      p_team: input.team === "t" ? "Terrorist" : input.team === "ct" ? "Counter-Terrorist" : null,
      p_query: input.query ?? null,
      p_limit: input.limit,
      p_offset: input.offset,
    });
    legacyXError(error, "Unable to load skinchanger catalog");
    const items = (data ?? []) as Array<DbRow & { total_count?: number | string }>;
    const total = Number(items[0]?.total_count ?? 0);
    sendPage(res, items.map(({ total_count: _total, ...item }) => ({ ...item, image_url: staticStorageUrl(req, item.image_key) })), total, input.limit, input.offset);
  }));

  router.get("/skinchanger/catalog/facets", userRoute(async (req, res) => {
    const input = z.object({ category: skinchangerCategorySchema.optional() }).parse(req.query);
    const { data, error } = await db().rpc("get_skinchanger_catalog_facets", { p_category: input.category ?? null });
    legacyXError(error, "Unable to load skinchanger catalog facets");
    res.json(data ?? { categories: [], weaponClasses: [] });
  }));

  /** The saved loadout with each entry's catalog item and accessories resolved; the same join serves the web and the plugin. */
  const loadSkinchangerLoadout = async (req: Request, userId: string) => {
    const { data, error } = await db().from("skinchanger_loadouts")
      .select("version,updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    legacyXError(error, "Unable to load skinchanger loadout");
    if (!data) return null;
    const loadout = data as DbRow;
    const { data: entryData, error: entryError } = await db().from("skinchanger_loadout_entries")
      .select("catalog_item_id,slot,slot_key,team_scope,options")
      .eq("user_id", userId)
      .order("slot_key")
      .order("team_scope");
    legacyXError(entryError, "Unable to load skinchanger loadout entries");
    const entries = (entryData ?? []) as DbRow[];
    const accessoryIds = Array.from(new Set(entries.flatMap((entry) => {
      const options = recordValue(entry.options);
      const stickers = Array.isArray(options.stickers) ? options.stickers : [];
      const stickerIds = stickers.map((sticker: unknown) => textValue(recordValue(sticker).catalogItemId)).filter(Boolean);
      const charmId = textValue(recordValue(options.charm).catalogItemId);
      return charmId ? [...stickerIds, charmId] : stickerIds;
    })));
    const catalogItemIds = Array.from(new Set(entries.map((entry) => textValue(entry.catalog_item_id)).filter(Boolean)));
    const catalogItemForResponse = (item: DbRow | null) => {
      if (!item) return null;
      return { ...item, image_url: staticStorageUrl(req, textValue(item.image_key) || null) };
    };
    const requestedCatalogIds = Array.from(new Set([...catalogItemIds, ...accessoryIds]));
    let catalogById = new Map<string, DbRow>();
    if (requestedCatalogIds.length) {
      const { data: catalogItems, error: catalogError } = await db().from("skinchanger_catalog_items")
        .select("id,external_key,category,weapon_class,display_name,weapon_defindex,paint_id,model,image_key,metadata")
        .in("id", requestedCatalogIds)
        .eq("is_active", true);
      legacyXError(catalogError, "Unable to resolve skinchanger catalog items");
      catalogById = new Map(((catalogItems ?? []) as DbRow[]).map((item) => [textValue(item.id), catalogItemForResponse(item) as DbRow]));
    }
    const enrichedEntries = entries.map((entry) => {
      const options = recordValue(entry.options);
      const stickers = Array.isArray(options.stickers) ? options.stickers : [];
      const ids = stickers.map((sticker: unknown) => textValue(recordValue(sticker).catalogItemId)).filter(Boolean);
      const charmId = textValue(recordValue(options.charm).catalogItemId);
      if (charmId) ids.push(charmId);
      return {
        ...entry,
        skinchanger_catalog_items: catalogById.get(textValue(entry.catalog_item_id)) ?? null,
        resolved_accessories: ids.map((id: string) => catalogById.get(id)).filter(Boolean),
      };
    });
    return { loadout, entries: enrichedEntries };
  };

  router.get("/skinchanger/loadout", userRoute(async (req, res, user) => {
    const result = await loadSkinchangerLoadout(req, user.id);
    if (!result) {
      res.json({ loadout: { version: 0, updated_at: null, skinchanger_loadout_entries: [] } });
      return;
    }
    res.json({ loadout: { ...result.loadout, skinchanger_loadout_entries: result.entries } });
  }));

  router.put("/skinchanger/loadout/entry", userRoute(async (req, res, user) => {
    const input = skinchangerEntryMutationSchema.parse(req.body);
    const entry = input.entry;
    const { data: selectedItems, error: selectedItemError } = await db().from("skinchanger_catalog_items")
      .select("id,category,metadata,weapon_class,display_name")
      .eq("is_active", true)
      .eq("id", entry.catalogItemId);
    legacyXError(selectedItemError, "Unable to validate selected item");
    const selectedItem = (selectedItems ?? [])[0] as DbRow | undefined;
    if (!selectedItem) apiError(400, "The selected item is unavailable");

    const requiredScope = catalogTeamScope(selectedItem.metadata, selectedItem.weapon_class, selectedItem.display_name);
    if (requiredScope !== "all" && entry.teamScope !== requiredScope) apiError(400, "This item is limited to one team");
    if ((entry.slot === "weapon" && !["weapon", "weapon_skin"].includes(textValue(selectedItem.category))) || (entry.slot !== "weapon" && textValue(selectedItem.category) !== entry.slot)) {
      apiError(400, "The selected item does not match this loadout slot");
    }

    const accessoryIds = Array.from(new Set([
      ...(entry.options.stickers?.map((sticker) => sticker.catalogItemId) ?? []),
      ...(entry.options.charm ? [entry.options.charm.catalogItemId] : []),
    ]));
    const accessoryDefindexes = new Map<string, { category: string; defindex: number | null }>();
    if (accessoryIds.length > 0) {
      const { data: accessories, error: accessoryError } = await db().from("skinchanger_catalog_items")
        .select("id,category,weapon_defindex")
        .eq("is_active", true)
        .in("id", accessoryIds);
      legacyXError(accessoryError, "Unable to validate custom items");
      for (const item of accessories ?? []) accessoryDefindexes.set(item.id, { category: item.category, defindex: item.weapon_defindex });
    }
    const resolveAccessoryDefindex = (catalogItemId: string, category: "sticker" | "charm") => {
      const item = accessoryDefindexes.get(catalogItemId);
      if (!item || item.category !== category || item.defindex === null) apiError(400, "One or more custom items are unavailable");
      return item.defindex;
    };
    const preparedEntry = {
      slot: entry.slot,
      slot_key: entry.slotKey,
      team_scope: requiredScope === "all" ? entry.teamScope : requiredScope,
      catalog_item_id: entry.catalogItemId,
      options: {
        ...entry.options,
        stickers: entry.options.stickers?.map((sticker) => ({ ...sticker, id: resolveAccessoryDefindex(sticker.catalogItemId, "sticker") })),
        charm: entry.options.charm ? { ...entry.options.charm, id: resolveAccessoryDefindex(entry.options.charm.catalogItemId, "charm") } : undefined,
      },
    };
    const { data, error } = await db().rpc("upsert_skinchanger_loadout_entry", {
      p_user_id: user.id,
      p_expected_version: input.expectedVersion,
      p_entry: preparedEntry,
    });
    legacyXError(error, "Unable to save skinchanger loadout entry");
    const outcome = recordValue(data);
    const version = numberValue(outcome.version);
    if (version < 1) apiError(500, "Loadout entry save did not return a version");
    const { error: auditError } = await db().from("audit_logs").insert({
      actor_type: "user",
      actor_id: user.id,
      action: "skinchanger.loadout.entry.upsert",
      target_type: "skinchanger_loadout_entries",
      target_id: `${preparedEntry.slot_key}:${preparedEntry.team_scope}`,
      metadata: { version, slot: preparedEntry.slot, slotKey: preparedEntry.slot_key, teamScope: preparedEntry.team_scope, catalogItemId: preparedEntry.catalog_item_id },
    });
    if (auditError) console.error("Unable to audit skinchanger entry save", auditError);
    res.json({ version });
  }));

  router.delete("/skinchanger/loadout/entry", userRoute(async (req, res, user) => {
    const input = skinchangerEntryRemovalSchema.parse(req.body);
    const { data, error } = await db().rpc("delete_skinchanger_loadout_entry", {
      p_user_id: user.id,
      p_expected_version: input.expectedVersion,
      p_slot_key: input.slotKey,
      p_team_scope: input.teamScope,
    });
    legacyXError(error, "Unable to remove skinchanger loadout entry");
    const outcome = recordValue(data);
    const version = numberValue(outcome.version);
    if (version < 1 || outcome.removed !== true) apiError(500, "Loadout entry removal did not complete");
    const { error: auditError } = await db().from("audit_logs").insert({
      actor_type: "user",
      actor_id: user.id,
      action: "skinchanger.loadout.entry.delete",
      target_type: "skinchanger_loadout_entries",
      target_id: `${input.slotKey}:${input.teamScope}`,
      metadata: { version, slotKey: input.slotKey, teamScope: input.teamScope },
    });
    if (auditError) console.error("Unable to audit skinchanger entry deletion", auditError);
    res.json({ version, removed: true });
  }));

  router.put("/skinchanger/loadout", userRoute(async (req, res, user) => {
    const input = skinchangerLoadoutSchema.parse(req.body);
    const selectedCatalogItemIds = Array.from(new Set(input.entries.map((entry) => entry.catalogItemId)));
    const itemTeamScopeById = new Map<string, "all" | "t" | "ct">();
    if (selectedCatalogItemIds.length > 0) {
      const { data, error } = await db().from("skinchanger_catalog_items")
        .select("id,metadata,weapon_class,display_name")
        .eq("is_active", true)
        .in("id", selectedCatalogItemIds);
      legacyXError(error, "Unable to validate selected items");
      if ((data ?? []).length !== selectedCatalogItemIds.length) apiError(400, "One or more selected items are unavailable");
      for (const item of data ?? []) {
        itemTeamScopeById.set(item.id, catalogTeamScope(item.metadata, item.weapon_class, item.display_name));
      }
    }
    const accessoryIds = Array.from(new Set(input.entries.flatMap((entry) => [
      ...(entry.options.stickers?.map((sticker) => sticker.catalogItemId) ?? []),
      ...(entry.options.charm ? [entry.options.charm.catalogItemId] : []),
    ])));
    const accessoryDefindexes = new Map<string, { category: string; defindex: number | null }>();
    if (accessoryIds.length > 0) {
      const { data, error } = await db().from("skinchanger_catalog_items")
        .select("id,category,weapon_defindex")
        .eq("is_active", true)
        .in("id", accessoryIds);
      legacyXError(error, "Unable to validate custom items");
      for (const item of data ?? []) accessoryDefindexes.set(item.id, { category: item.category, defindex: item.weapon_defindex });
    }
    const resolveAccessoryDefindex = (catalogItemId: string, category: "sticker" | "charm") => {
      const item = accessoryDefindexes.get(catalogItemId);
      if (!item || item.category !== category || item.defindex === null) apiError(400, "One or more custom items are unavailable");
      return item.defindex;
    };
    const entries = input.entries.map(entry => {
      const requiredScope = itemTeamScopeById.get(entry.catalogItemId) ?? "all";
      if (requiredScope !== "all" && entry.teamScope !== requiredScope) apiError(400, "This item is limited to one team");
      return {
      slot: entry.slot,
      slot_key: entry.slotKey,
      team_scope: requiredScope === "all" ? entry.teamScope : requiredScope,
      catalog_item_id: entry.catalogItemId,
      options: {
        ...entry.options,
        stickers: entry.options.stickers?.map((sticker) => ({
          ...sticker,
          id: resolveAccessoryDefindex(sticker.catalogItemId, "sticker"),
        })),
        charm: entry.options.charm ? {
          ...entry.options.charm,
          id: resolveAccessoryDefindex(entry.options.charm.catalogItemId, "charm"),
        } : undefined,
      },
    };
    });
    const { data: version, error } = await db().rpc("save_skinchanger_loadout", { p_user_id: user.id, p_entries: entries });
    legacyXError(error, "Unable to save skinchanger loadout");
    const { error: auditError } = await db().from("audit_logs").insert({
      actor_type: "user",
      actor_id: user.id,
      action: "skinchanger.loadout.save",
      target_type: "skinchanger_loadouts",
      target_id: user.id,
      metadata: { version, entryCount: entries.length },
    });
    // A durable loadout has already been saved at this point. Audit outages must
    // never make the player believe their saved look failed or roll UI state back.
    if (auditError) console.error("Unable to audit skinchanger loadout", auditError);
    res.json({ version, entryCount: entries.length });
  }));





  router.get("/moderation/penalties", asyncRoute(async (req, res) => {
    const filters = z.object({
      type: penaltyTypeSchema.optional(),
      /** Player name, or a SteamID64 (the website extracts it from a pasted profile link). */
      query: z.string().trim().min(1).max(64).optional(),
      /** Issuing admin (name or SteamID64): the staff profile's "Penalties issued" link. */
      admin: z.string().trim().min(1).max(64).optional(),
    }).parse(req.query);
    let query = db().from("penalties").select("*,users!penalties_user_id_fkey(username,steam_id,avatar)").order("created_at", { ascending: false });
    if (filters.type) query = query.eq("type", filters.type);
    const { data, error } = await query;
    legacyXError(error, "Unable to load penalties");
    let penalties = await mapPenaltiesWithProfileIdentities((data ?? []) as DbRow[], db());
    if (filters.query) {
      const needle = filters.query.toLowerCase();
      penalties = penalties.filter(penalty => penalty.player.toLowerCase().includes(needle) || penalty.playerSteamId === filters.query);
    }
    if (filters.admin) {
      const needle = filters.admin.toLowerCase();
      penalties = penalties.filter(penalty => penalty.admin.toLowerCase() === needle || penalty.adminSteamId === filters.admin);
    }
    res.json(penalties);
  }));
  router.get("/moderation/penalties/stats", asyncRoute(async (_req, res) => {
    const { data, error } = await db().from("penalties").select("type,is_permanent,is_unbanned");
    legacyXError(error, "Unable to load penalty statistics");
    const penalties = (data ?? []) as DbRow[];
    res.json({ totalBans: penalties.filter(row => row.type === "ban").length, activeBans: penalties.filter(row => row.type === "ban" && !row.is_unbanned).length, permanentBans: penalties.filter(row => row.type === "ban" && row.is_permanent).length, totalComms: penalties.filter(row => row.type === "comm").length, totalGags: penalties.filter(row => row.type === "gag").length });
  }));
  router.get("/penalties/:penaltyId", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("penalties").select("*,users!penalties_user_id_fkey(username,steam_id,avatar)").eq("id", userIdSchema.parse(req.params.penaltyId)).maybeSingle();
    legacyXError(error, "Unable to load penalty");
    if (!data) apiError(404, "Penalty was not found");
    const [penalty] = await mapPenaltiesWithProfileIdentities([data as DbRow], db());
    res.json(penalty);
  }));

  router.get("/feedback", asyncRoute(async (_req, res) => {
    const { data, error } = await db().from("feedback").select("id,user_id,name,rating,message,created_at").order("created_at", { ascending: false });
    legacyXError(error, "Unable to load feedback");
    res.json(await mapFeedbackRows((data ?? []) as DbRow[]));
  }));
  router.post("/feedback", userRoute(async (req, res, user) => {
    const input = z.object({ rating: z.number().int().min(1).max(5), message: z.string().trim().min(1).max(4000) }).parse(req.body);
    const { data, error } = await db().rpc("submit_feedback_weekly", {
      p_user_id: user.id,
      p_name: user.username,
      p_rating: input.rating,
      p_message: input.message,
    });
    legacyXError(error, "Unable to submit feedback");
    const outcome = (data ?? {}) as { accepted?: boolean; next_eligible_at?: string; feedback?: DbRow };
    if (!outcome.accepted) {
      const nextEligibleAt = textValue(outcome.next_eligible_at);
      res.status(429).json({ error: "weekly_cooldown", nextEligibleAt: nextEligibleAt || null });
      return;
    }
    if (!outcome.feedback) apiError(500, "Feedback submission did not return a review.");
    res.status(201).json(mapFeedback(outcome.feedback, new Map([[user.id, { steamId: user.steamId, avatar: "" }]])));
  }));

  router.get("/search/players", asyncRoute(async (req, res) => {
    const input = z.object({ query: z.string().trim().min(1).max(64) }).parse(req.query);
    // A SteamID64 (the website extracts it from pasted profile links) matches exactly; anything else is a name search.
    const isSteamId = /^\d{15,20}$/.test(input.query);
    const pattern = input.query.replace(/[\\%_]/g, (char) => `\\${char}`);
    let query = db().from("competitive_leaderboard").select("user_id,steam_id,username,avatar,rank_id,matches_completed,wins,kills,deaths,kd_ratio,win_rate,played_hours,last_match_at");
    query = isSteamId ? query.eq("steam_id", input.query) : query.ilike("username", `%${pattern}%`);
    const { data, error } = await query.order("username").limit(60);
    legacyXError(error, "Unable to search players");
    const rows = (data ?? []) as DbRow[];
    const statuses = await resolveModerationStatuses(rows.map(row => textValue(row.user_id)), db());
    res.json({ players: rows.map(row => ({
      id: textValue(row.user_id),
      steamId: textValue(row.steam_id),
      name: textValue(row.username),
      avatar: textValue(row.avatar),
      rankId: numberValue(row.rank_id),
      kills: numberValue(row.kills) ?? 0,
      deaths: numberValue(row.deaths) ?? 0,
      kd: numberValue(row.kd_ratio) ?? 0,
      matches: numberValue(row.matches_completed) ?? 0,
      wins: numberValue(row.wins) ?? 0,
      winRate: numberValue(row.win_rate) ?? 0,
      playedHours: numberValue(row.played_hours) ?? 0,
      lastPlayed: textValue(row.last_match_at) || null,
      moderationStatus: statuses.get(textValue(row.user_id)) ?? "Clear",
    })) });
  }));
  router.get("/community/content", asyncRoute(async (_req, res) => {
    const [creators, partners] = await Promise.all([
      db().from("community_creators").select("id,name,handle,url").order("created_at"),
      db().from("community_partners").select("id,name,description,type,url").order("created_at"),
    ]);
    legacyXError(creators.error || partners.error, "Unable to load community content");
    const websitePartners = ((partners.data ?? []) as DbRow[])
      .filter((partner) => textValue(partner.type) === "website")
      .map((partner) => ({ id: textValue(partner.id), name: textValue(partner.name), description: textValue(partner.description), type: "website" as const, url: textValue(partner.url) }));
    res.json({ creators: creators.data ?? [], partners: websitePartners });
  }));

  router.get("/health", (_req, res) => res.json({ ok: true, service: "legacy-x-api" }));

  const beginSteam = (req: Request, res: Response) => {
    const staffPanel = req.query.staffpanel === "1";
    const origin = steamOpenIdOrigin(req);
    const callback = staffPanel ? `${origin}/api/v1/auth/steam/callback?staffpanel=1` : undefined;
    res.redirect(302, steamLoginUrl(origin, callback));
  };
  router.get("/auth/steam", beginSteam);
  router.post("/auth/steam", beginSteam);
  router.get("/auth/steam/callback", asyncRoute(async (req, res) => {
    const staffPanel = req.query.staffpanel === "1";
    const redirect = postLoginRedirect();
    try {
      const steamId = await verifySteamCallback(req.query as Record<string, unknown>);
      let userId: string | null = null;
      if (staffPanel) {
        const { data: identity, error } = await db().from("users").select("id").eq("steam_id", steamId).maybeSingle();
        legacyXError(error, "Unable to resolve Staff Panel identity");
        if (!redirect) apiError(500, "POST_LOGIN_REDIRECT or FRONTEND_ORIGIN must be configured for Steam login");
        if (!identity?.id) {
          res.setHeader("Cache-Control", "no-store");
          res.redirect(302, new URL("/", redirect).toString());
          return;
        }
        userId = identity.id;
      } else {
        const { data, error } = await db().rpc("ensure_steam_user", { p_steam_id: steamId, p_username: `Steam ${steamId}`, p_avatar: "" });
        legacyXError(error, "Unable to create Steam user");
        if (!data) apiError(500, "Steam user was not created");
        userId = data;
        await syncSteamUserProfile(steamId);
      }
      if (!userId) apiError(401, "Steam identity is not eligible for Staff Panel access");
      const user = await getUserWithStats(userId);
      const principal: LegacyUser = { id: user.id, steamId: user.steam_id, username: user.username };
      if (staffPanel) {
        const staffSession = await createStaffSession(principal.id);
        res.setHeader("Cache-Control", "no-store");
        if (!redirect) apiError(500, "POST_LOGIN_REDIRECT or FRONTEND_ORIGIN must be configured for Steam login");
        if (!staffSession) {
          res.redirect(302, new URL("/", redirect).toString());
          return;
        }
        res.cookie("legacyx_staff_session", staffSession, staffSessionCookieOptions(15 * 60 * 1000));
        res.redirect(302, new URL("/staffpanel?reauth=done", redirect).toString());
        return;
      }
      const [accessToken, refreshToken] = await Promise.all([issueAccessToken(principal), createRefreshSession(principal.id)]);
      res.cookie("legacyx_access_token", accessToken, sessionCookieOptions(15 * 60 * 1000));
      res.cookie("legacyx_refresh_token", refreshToken, sessionCookieOptions(30 * 24 * 60 * 1000));
      if (redirect) {
        res.setHeader("Cache-Control", "no-store");
        res.redirect(302, redirect);
        return;
      }
      apiError(500, "POST_LOGIN_REDIRECT or FRONTEND_ORIGIN must be configured for Steam login");
    } catch (error) {
      if (!staffPanel || !redirect) throw error;
      const trace = randomBytes(8).toString("hex");
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      const code = status >= 500 ? "staff_setup_required" : "staff_auth_failed";
      console.error("[legacy-x-api] staffpanel_callback_failed", { trace, status, message: error instanceof Error ? error.message : "Unknown error" });
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, new URL(`/staffpanel?staff_error=${code}&trace=${trace}`, redirect).toString());
    }
  }));

  router.get("/staffpanel/access", staffPanelRoute(async (_req, res, staff) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      role: staff.role,
      username: staff.username,
      capabilities: staff.role === "OWNER"
        ? ["database_overview", "products", "repository_downloads", "restart_all", "restart_server", "start_server", "stop_server", "ban", "unban", "kick", "mute", "timeout", "unpause", "round_restart", "round_restore", "map_change", "server_announcement", "match_announcement", "hud_announcement", "player_hud_alert", "player_message", "player_ip_lookup", "rename", "staff_governance", "maintenance", "health"]
        : ["ban", "unban", "kick", "mute", "map_change", "match_announcement", "hud_announcement", "player_hud_alert", "player_message", "rename"],
    });
  }));

  router.get("/staffpanel/overview", staffPanelRoute(async (_req, res, staff) => {
    requireStaffCapability(staff, "overview");
    const [servers, pendingActions] = await Promise.all([
      db().from("reconnect_servers").select("server_id,name,map_name,mode,player_count,last_heartbeat_at").order("name"),
      db().from("staff_panel_actions").select("id,status,action_type,server_id,created_at").in("status", ["pending", "claimed"]).order("created_at", { ascending: false }).limit(12),
    ]);
    legacyXError(servers.error || pendingActions.error, "Unable to load staff panel overview");
    res.json({ role: staff.role, servers: servers.data ?? [], pendingActions: pendingActions.data ?? [] });
  }));

  router.get("/staffpanel/servers/:serverId/roster", staffPanelRoute(async (req, res, staff) => {
    requireStaffCapability(staff, "overview");
    const serverId = staffPanelServerSchema.parse(req.params.serverId);
    const [serverResult, snapshotResult, sessionsResult] = await Promise.all([
      db().schema("legacy_x").from("reconnect_servers").select("server_id,display_name,current_map,current_mode,player_count,last_heartbeat_at").eq("server_id", serverId).maybeSingle(),
      db().schema("legacy_x").from("server_live_match_snapshots").select("state,map_name,terrorist_players,counter_terrorist_players,spectator_players,reported_at").eq("server_id", serverId).maybeSingle(),
      db().schema("legacy_x").from("reconnect_sessions").select("steam_id,player_name,connected_at").eq("server_id", serverId).is("disconnected_at", null).order("connected_at").limit(64),
    ]);
    legacyXError(serverResult.error || snapshotResult.error || sessionsResult.error, "Unable to load staff server roster");
    if (!serverResult.data) apiError(404, "Server was not found");

    const snapshot = snapshotResult.data as DbRow | null;
    const reportedAt = textValue(snapshot?.reported_at);
    const reportedAtMs = Date.parse(reportedAt);
    const hasSnapshot = Boolean(snapshot) && Number.isFinite(reportedAtMs) && Date.now() - reportedAtMs <= 90_000;
    const normalizePlayers = (value: unknown, team: "T" | "CT" | "SPECTATOR") => z.array(liveMatchPlayerSchema).safeParse(value).success
      ? z.array(liveMatchPlayerSchema).parse(value).map(player => ({ steamId: player.steam_id, name: player.name, team, connected: player.connected, rankId: player.rank_id ?? null, rankName: player.rank_name ?? null, rankImageKey: player.rank_image_key ?? null, adr: player.adr ?? null, ping: player.ping ?? null }))
      : [];
    const rosterOnly = ((sessionsResult.data ?? []) as DbRow[]).map(session => ({ steamId: textValue(session.steam_id), name: textValue(session.player_name) || "Unknown player", team: "UNASSIGNED" as const, connected: true, rankId: null, rankName: null, rankImageKey: null, adr: null, ping: null }));
    const players = hasSnapshot
      ? [...normalizePlayers(snapshot?.terrorist_players, "T"), ...normalizePlayers(snapshot?.counter_terrorist_players, "CT"), ...normalizePlayers(snapshot?.spectator_players, "SPECTATOR")]
      : rosterOnly;
    res.json({ server: { id: serverId, name: textValue(serverResult.data.display_name) || serverId, map: textValue(snapshot?.map_name) || textValue(serverResult.data.current_map) || "Unknown", mode: textValue(serverResult.data.current_mode) || "Community", playerCount: numberValue(serverResult.data.player_count), state: hasSnapshot ? textValue(snapshot?.state) : "unavailable", availability: hasSnapshot ? "live_snapshot" : rosterOnly.length > 0 ? "roster_only" : "unavailable", updatedAt: hasSnapshot ? reportedAt : textValue(serverResult.data.last_heartbeat_at) || null }, players });
  }));

  router.get("/staffpanel/players/:steamId/penalties", staffPanelRoute(async (req, res, staff) => {
    requireStaffCapability(staff, "overview");
    const steamId = z.string().regex(/^\d{17}$/).parse(req.params.steamId);
    const { data: player, error: playerError } = await db().from("users").select("id").eq("steam_id", steamId).maybeSingle();
    legacyXError(playerError, "Unable to resolve player penalties");
    if (!player) {
      res.json({ penalties: [] });
      return;
    }
    const { data, error } = await db().from("penalties").select("*,users!penalties_user_id_fkey(id,username,steam_id,avatar)").eq("user_id", player.id).order("created_at", { ascending: false }).limit(50);
    legacyXError(error, "Unable to load player penalties");
    const penalties = await mapPenaltiesWithProfileIdentities((data ?? []) as DbRow[], db());
    res.json({ penalties });
  }));

  router.get("/staffpanel/database", ownerPanelRoute(async (_req, res) => {
    const [users, penalties, matches, actions] = await Promise.all([
      db().from("users").select("id", { count: "exact", head: true }),
      db().from("penalties").select("id", { count: "exact", head: true }),
      db().from("matches").select("id", { count: "exact", head: true }),
      db().from("staff_panel_actions").select("id", { count: "exact", head: true }),
    ]);
    legacyXError(users.error || penalties.error || matches.error || actions.error, "Unable to load database overview");
    res.json({ tables: [
      { name: "users", count: users.count ?? 0 }, { name: "penalties", count: penalties.count ?? 0 },
      { name: "matches", count: matches.count ?? 0 },
      { name: "staff_panel_actions", count: actions.count ?? 0 },
    ] });
  }));
  router.get("/staffpanel/anti-cheat/phantom-evidence", staffPanelRoute(async (_req, res) => {
    const { data, error } = await db().from("phantom_evidence_events").select("id,event_id,match_reference,server_id,server_mode,steam_id,phantom_id,mapped_steam_id,round_number,tick,interaction_type,interaction_count,suspicion_score,evidence_confidence,occurred_at").order("occurred_at", { ascending: false }).limit(250);
    legacyXError(error, "Unable to load Phantom evidence");
    res.json({ evidence: data ?? [] });
  }));
  router.get("/staffpanel/anti-cheat/phantom-cases", staffPanelRoute(async (_req, res) => {
    const { data, error } = await db().from("phantom_suspension_cases").select("id,match_reference,server_id,server_mode,steam_id,status,suspicion_score,evidence_count,evidence_summary,suspended_at,reviewed_at,review_note,reviewed_by_staff_id,updated_at").order("updated_at", { ascending: false }).limit(250);
    legacyXError(error, "Unable to load Phantom suspension cases");
    res.json({ cases: data ?? [] });
  }));
  router.patch("/staffpanel/anti-cheat/phantom-cases/:caseId", staffPanelRoute(async (req, res, staff) => {
    const input = phantomCaseReviewSchema.parse(req.body);
    const caseId = z.string().uuid().parse(req.params.caseId);
    const { data: current, error: currentError } = await db().from("phantom_suspension_cases").select("id,server_id,steam_id,status").eq("id", caseId).maybeSingle();
    legacyXError(currentError, "Unable to load Phantom suspension case");
    if (!current) apiError(404, "Phantom suspension case was not found");
    const nextStatus = input.decision === "clear" ? "CLEARED" : input.decision === "confirm_ban" ? "CONFIRMED" : "SUSPENDED";
    const { data, error } = await db().from("phantom_suspension_cases").update({ status: nextStatus, reviewed_by_staff_id: staff.staffId, reviewed_at: new Date().toISOString(), review_note: input.note, requires_manager_review: input.decision === "keep" }).eq("id", caseId).select("id,status,server_id,steam_id,reviewed_at").single();
    legacyXError(error, "Unable to review Phantom suspension case");
    if (input.decision === "confirm_ban") {
      const queue = await db().from("staff_panel_actions").insert({ server_id: textValue(current.server_id), requested_by: staff.userId, requested_by_staff_id: staff.staffId, action_type: "ban", payload: { type: "ban", serverId: textValue(current.server_id), playerSteamId: textValue(current.steam_id), banTerm: "permanent", enforceAfterSeconds: 10, message: `Phantom suspension confirmed after ${staff.role} review: ${input.note}` }, status: "pending" });
      legacyXError(queue.error, "Unable to queue reviewed Phantom ban");
    }
    const audit = await db().from("staff_audit_logs").insert({ staff_id: staff.staffId, event_type: "phantom_case_reviewed", target_type: "phantom_suspension_case", target_id: caseId, metadata: { decision: input.decision, note: input.note, previous_status: textValue(current.status), next_status: nextStatus } });
    legacyXError(audit.error, "Unable to audit Phantom case review");
    res.json({ case: data });
  }));

  router.get("/staffpanel/staff", ownerPanelRoute(async (_req, res) => {
    const { data, error } = await db().from("staff").select("id,user_id,role,permissions,game_permissions,stamina,immunity,status,created_at,updated_at,users(username,steam_id,avatar)").order("created_at", { ascending: false });
    legacyXError(error, "Unable to load staff directory");
    res.json(((data ?? []) as DbRow[]).map((member) => {
      const user = firstRow(member.users) ?? {};
      return { id: textValue(member.id), userId: textValue(member.user_id), username: textValue(user.username), steamId: textValue(user.steam_id), avatar: textValue(user.avatar), role: textValue(member.role), permissions: Array.isArray(member.permissions) ? member.permissions.filter((value): value is string => typeof value === "string") : [], gamePermissions: Array.isArray(member.game_permissions) ? member.game_permissions.filter((value): value is string => typeof value === "string") : [], stamina: Math.max(0, Math.min(1000, numberValue(member.stamina) ?? staffRoleNumericDefaults[member.role as keyof typeof staffRoleNumericDefaults] ?? 0)), immunity: Math.max(0, Math.min(1000, numberValue(member.immunity) ?? staffRoleNumericDefaults[member.role as keyof typeof staffRoleNumericDefaults] ?? 0)), status: textValue(member.status), createdAt: timestampValue(member.created_at), updatedAt: timestampValue(member.updated_at) };
    }));
  }));
  router.post("/staffpanel/staff", ownerPanelRoute(async (req, res, staff) => {
    const input = staffMemberCreateSchema.parse(req.body);
    const numericDefault = staffRoleNumericDefaults[input.role];
    const stamina = input.stamina ?? numericDefault;
    const immunity = input.immunity ?? numericDefault;
    const { data, error } = await db().from("staff").insert({ user_id: input.userId, role: input.role, permissions: input.permissions, game_permissions: input.gamePermissions, stamina, immunity, status: input.status }).select("id,user_id,role,permissions,game_permissions,stamina,immunity,status,created_at,updated_at").single();
    legacyXError(error, "Unable to create staff record");
    const audit = await db().from("staff_audit_logs").insert({ staff_id: staff.staffId, event_type: "staff_member_created", target_type: "staff", target_id: textValue((data as DbRow).id), metadata: { user_id: input.userId, role: input.role, permissions: input.permissions, game_permissions: input.gamePermissions, stamina, immunity, status: input.status } });
    legacyXError(audit.error, "Unable to audit staff record creation");
    res.status(201).json(data);
  }));
  router.patch("/staffpanel/staff/:staffId", ownerPanelRoute(async (req, res, staff) => {
    const staffId = userIdSchema.parse(req.params.staffId);
    const input = staffMemberUpdateSchema.parse(req.body);
    const { data: current, error: currentError } = await db().from("staff").select("id,role,status").eq("id", staffId).maybeSingle();
    legacyXError(currentError, "Unable to resolve staff record");
    if (!current) apiError(404, "Staff record was not found");
    const removesActiveOwner = current.role === "OWNER" && current.status === "active" && ((input.role !== undefined && input.role !== "OWNER") || (input.status !== undefined && input.status !== "active"));
    if (removesActiveOwner) {
      const { count, error } = await db().from("staff").select("id", { count: "exact", head: true }).eq("role", "OWNER").eq("status", "active");
      legacyXError(error, "Unable to verify active Owner count");
      if ((count ?? 0) <= 1) apiError(409, "The last active Owner cannot be changed or deactivated");
    }
    const { data, error } = await db().from("staff").update({ ...(input.role === undefined ? {} : { role: input.role }), ...(input.permissions === undefined ? {} : { permissions: input.permissions }), ...(input.gamePermissions === undefined ? {} : { game_permissions: input.gamePermissions }), ...(input.stamina === undefined ? {} : { stamina: input.stamina }), ...(input.immunity === undefined ? {} : { immunity: input.immunity }), ...(input.status === undefined ? {} : { status: input.status }), updated_at: new Date().toISOString() }).eq("id", staffId).select("id,user_id,role,permissions,game_permissions,stamina,immunity,status,created_at,updated_at").single();
    legacyXError(error, "Unable to update staff record");
    const audit = await db().from("staff_audit_logs").insert({ staff_id: staff.staffId, event_type: "staff_member_updated", target_type: "staff", target_id: staffId, metadata: input });
    legacyXError(audit.error, "Unable to audit staff record update");
    res.json(data);
  }));
  router.get("/staffpanel/maintenance", ownerPanelRoute(async (_req, res) => {
    const { data, error } = await db().from("staff_panel_settings").select("value,updated_at").eq("setting_key", "maintenance:legacyx.cc").maybeSingle();
    legacyXError(error, "Unable to load maintenance configuration");
    const value = data?.value && typeof data.value === "object" ? data.value as DbRow : {};
    res.json({ website: "legacyx.cc", enabled: value.enabled === true, updatedAt: data?.updated_at ?? null, availability: data ? "configured" : "not_configured" });
  }));
  router.put("/staffpanel/maintenance", ownerPanelRoute(async (req, res, staff) => {
    const input = staffMaintenanceSchema.parse(req.body);
    const { data, error } = await db().from("staff_panel_settings").upsert({ setting_key: `maintenance:${input.website}`, value: { enabled: input.enabled }, updated_by_staff_id: staff.staffId, updated_at: new Date().toISOString() }, { onConflict: "setting_key" }).select("value,updated_at").single();
    legacyXError(error, "Unable to save maintenance configuration");
    const audit = await db().from("staff_audit_logs").insert({ staff_id: staff.staffId, event_type: "maintenance_configuration_updated", target_type: "website", target_id: input.website, metadata: { enabled: input.enabled } });
    legacyXError(audit.error, "Unable to audit maintenance configuration");
    res.json({ website: input.website, enabled: Boolean((data?.value as DbRow | undefined)?.enabled), updatedAt: data?.updated_at ?? null, availability: "configured" });
  }));
  router.get("/staffpanel/health", ownerPanelRoute(async (_req, res) => {
    const { data, error } = await db().from("server_health_snapshots").select("cpu_percent,memory_percent,disk_percent,load_average,healthy,reported_at").order("reported_at", { ascending: false }).limit(1).maybeSingle();
    legacyXError(error, "Unable to load server health telemetry");
    res.json(data ? { availability: "telemetry", cpuPercent: data.cpu_percent, memoryPercent: data.memory_percent, diskPercent: data.disk_percent, loadAverage: data.load_average, healthy: data.healthy, updatedAt: data.reported_at } : { availability: "unavailable", cpuPercent: null, memoryPercent: null, diskPercent: null, loadAverage: null, healthy: null, updatedAt: null });
  }));

  router.post("/staffpanel/actions", staffPanelRoute(async (req, res, staff) => {
    const input = staffPanelActionSchema.parse(req.body);
    requireStaffCapability(staff, input.type);
    const { data: targetServer, error: targetServerError } = await db().schema("legacy_x").from("reconnect_servers").select("server_id").eq("server_id", input.serverId).maybeSingle();
    legacyXError(targetServerError, "Unable to validate target server");
    if (!targetServer) apiError(404, "Target server was not found");
    const { data, error } = await db().from("staff_panel_actions").insert({
      server_id: input.serverId,
      requested_by: staff.userId,
      requested_by_staff_id: staff.staffId,
      action_type: input.type,
      payload: input,
      status: "pending",
    }).select("id,status,action_type,server_id,created_at").single();
    legacyXError(error, "Unable to queue server action");
    const audit = await db().from("staff_audit_logs").insert({
      staff_id: staff.staffId,
      event_type: "staffpanel_action_queued",
      target_type: "server_action",
      target_id: (data as DbRow).id,
      metadata: { action_type: input.type, server_id: input.serverId, player_steam_id: input.playerSteamId ?? null, target_map: input.type === "map_change" ? input.map : null, map_impact_acknowledged: input.type === "map_change" ? input.mapImpactAcknowledged === true : null, timeout_seconds: input.type === "timeout" ? input.durationSeconds : null, enforce_after_seconds: input.enforceAfterSeconds ?? null },
    });
    legacyXError(audit.error, "Unable to audit server action");
    res.status(202).json({ action: data });
  }));


  router.get("/competitive/me/access", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("competitive_player_profiles").select("current_exp,rank_id,rank_name,rank_image_key,pro_league_unlocked").eq("user_id", user.id).maybeSingle();
    legacyXError(error, "Unable to load competitive access");
    res.json({
      competitive: data ?? null,
      proLeagueUnlocked: Boolean(data?.pro_league_unlocked),
      requiredRankId: PRO_LEAGUE_RANK_ID,
      requiredRankName: rankById(PRO_LEAGUE_RANK_ID)!.name,
      requiredRankImageKey: rankById(PRO_LEAGUE_RANK_ID)!.imageKey,
      requiredExp: PRO_LEAGUE_UNLOCK_EXP,
      keepExp: PRO_LEAGUE_KEEP_EXP,
    });
  }));







  router.post("/community/content", pluginRoute("community:write", async (req, res, plugin) => {
    const input = z.object({ kind: z.enum(["creator", "partner"]), name: z.string().trim().min(1).max(100), handle: z.string().trim().max(100).optional(), description: z.string().trim().max(2000).optional(), type: z.literal("website").optional(), url: z.string().url().max(2048) }).parse(req.body);
    const { data, error } = await db().rpc("plugin_write_community_content", { p_plugin_id: plugin.id, p_kind: input.kind, p_name: input.name, p_handle: input.handle ?? null, p_description: input.description ?? null, p_partner_type: input.type ?? "website", p_url: input.url });
    legacyXError(error, "Unable to write community content");
    res.status(201).json({ contentId: data });
  }));

  router.post("/plugin/maps", pluginRoute("maps:write", async (req, res, plugin) => {
    const input = z.object({ id: z.string().trim().min(1).max(64), label: z.string().trim().min(1).max(100) }).parse(req.body);
    const { data, error } = await db().from("maps").upsert(input, { onConflict: "id" }).select("*").single();
    legacyXError(error, "Unable to upsert map");
    await writePluginAudit(plugin, "map.upsert", "maps", null, { map: input.id });
    res.status(201).json({ map: data });
  }));
  router.post("/plugin/servers", pluginRoute("servers:write", async (req, res, plugin) => {
    const input = pluginServerSchema.parse(req.body);
    const { data, error } = await db().from("game_servers").insert(input).select("*").single();
    legacyXError(error, "Unable to create game server");
    await writePluginAudit(plugin, "server.create", "game_servers", data.id, { name: data.name, status: data.status });
    res.status(201).json({ server: data });
  }));
  router.put("/plugin/servers/:serverId/status", pluginRoute("servers:write", async (req, res, plugin) => {
    const input = pluginServerSchema.omit({ id: true, name: true, map: true, mode: true }).parse(req.body);
    const { data, error } = await db().from("game_servers").update(input).eq("id", req.params.serverId).select("*").single();
    legacyXError(error, "Unable to update game server status");
    await writePluginAudit(plugin, "server.status.update", "game_servers", data.id, { status: data.status, currentPlayers: data.current_players });
    res.json({ server: data });
  }));

  router.post("/plugin/match-core/events", pluginRoute("matches:write", async (req, res, plugin) => {
    const parsed = matchCoreEventSchema.parse(req.body);
    const input = { ...parsed, event_type: parsed.event_type ?? parsed.event! };
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-match-core") apiError(403, "Match Core plugin identity is required");
    const { data, error } = await db().schema("legacy_x").rpc("ingest_core_match_event", { p_plugin_id: pluginId, p_event_id: input.event_id, p_payload: input });
    legacyXError(error, "Unable to ingest Match Core event");
    const matchCoreResult = recordValue(data);
    let competitive: unknown = null;
    if (input.event_type === "result_final" && ["processed", "duplicate"].includes(textValue(matchCoreResult.status))) {
      if (!input.match_id) apiError(400, "match_id is required for result_final");
      competitive = await applyCompetitiveResult(db(), { pluginId, eventId: input.event_id, matchId: input.match_id, payload: input });
    }
    res.status(200).json({ result: data ?? {}, competitive });
  }));
  router.post("/plugin/matchzy/events", pluginRoute("stats:write", async (req, res, plugin) => {
    z.object({ event_id: pluginEventIdSchema, event: z.string().min(1).max(64) }).passthrough().parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "matchzy") apiError(403, "MatchZy plugin identity is required");
    // Competitive EXP is final-match only through authenticated Match Core. The
    // legacy map callback remains accepted as telemetry so old MatchZy builds do
    // not fail, but it can never create a second progression authority.
    res.status(202).json({ accepted: true, ignored: true, reason: "competitive_exp_is_awarded_by_match_core_final_only" });
  }));
  router.post("/plugin/player-telemetry/events", pluginRoute("stats:write", async (req, res, plugin) => {
    const input = playerTelemetryEventSchema.parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-player-telemetry") apiError(403, "Player Telemetry plugin identity is required");
    const { data, error } = await db().schema("legacy_x").rpc("ingest_player_telemetry_event", {
      p_plugin_id: pluginId,
      p_event_id: input.event_id,
      p_payload: input,
    });
    legacyXError(error, "Unable to ingest player telemetry event");
    const progressionLookup = input.event_type === "round_snapshot"
      ? await db().from("competitive_player_profiles").select("current_exp,rank_name").eq("steam_id", input.steam_id).maybeSingle()
      : { data: null, error: null };
    if (progressionLookup.error) console.warn("[legacy-x-api] Round progression snapshot unavailable", progressionLookup.error.message);
    const progression = progressionLookup.data && numberValue((progressionLookup.data as DbRow).current_exp) !== null
      ? { experience: numberValue((progressionLookup.data as DbRow).current_exp)!, rankName: textValue((progressionLookup.data as DbRow).rank_name) || "Unranked" }
      : null;
    await writePluginAudit(plugin, `player_telemetry.${input.event_type}`, "player_telemetry_events", input.steam_id, {
      eventId: input.event_id,
      serverId: input.server_id,
      matchReference: input.match_reference,
      roundNumber: input.round_number,
      disconnectMethod: input.disconnect_method ?? null,
    });
    res.status(202).json({ result: data ?? {}, progression });
  }));
  router.post("/plugin/phantom/evidence", pluginRoute("phantom:write", async (req, res, plugin) => {
    const input = phantomEvidenceSchema.parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-phantom") apiError(403, "LegacyX Phantom plugin identity is required");
    const { data, error } = await db().schema("legacy_x").rpc("ingest_phantom_evidence", { p_plugin_id: pluginId, p_event_id: input.event_id, p_payload: input });
    legacyXError(error, "Unable to ingest Phantom evidence");
    await writePluginAudit(plugin, `phantom.${input.interaction_type}`, "phantom_evidence_events", input.steam_id, { eventId: input.event_id, matchReference: input.match_reference, serverId: input.server_id, phantomId: input.phantom_id, score: input.suspicion_score, confidence: input.evidence_confidence });
    res.status(202).json({ result: data ?? {} });
  }));
  router.post("/plugin/phantom/suspensions", pluginRoute("phantom:write", async (req, res, plugin) => {
    const input = phantomSuspensionSignalSchema.parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-phantom") apiError(403, "LegacyX Phantom plugin identity is required");
    const { data, error } = await db().schema("legacy_x").rpc("ingest_phantom_suspension_signal", { p_plugin_id: pluginId, p_event_id: input.event_id, p_payload: input });
    legacyXError(error, "Unable to ingest Phantom suspension signal");
    await writePluginAudit(plugin, `phantom.${input.event_type}`, "phantom_suspension_cases", input.steam_id, { eventId: input.event_id, matchReference: input.match_reference, serverId: input.server_id, score: input.suspicion_score, evidenceCount: input.evidence_count });
    res.status(202).json({ result: data ?? {} });
  }));
  router.post("/plugin/phantom/history/rounds", pluginRoute("phantom:write", async (req, res, plugin) => {
    const input = phantomHistoryRoundSchema.parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-phantom") apiError(403, "LegacyX Phantom plugin identity is required");
    const { data, error } = await db().from("phantom_history_rounds").upsert({ plugin_id: pluginId, source_ref: input.source_ref, match_reference: input.match_reference, server_id: input.server_id, server_mode: input.server_mode, map_name: input.map_name, round_number: input.round_number, sample_count: input.samples.length, samples: input.samples, completed_at: input.completed_at }, { onConflict: "server_id,match_reference,round_number,source_ref", ignoreDuplicates: true }).select("id").maybeSingle();
    legacyXError(error, "Unable to ingest Phantom history round");
    res.status(202).json({ accepted: Boolean(data), sampleCount: input.samples.length });
  }));
  router.get("/plugin/phantom/history/rounds", pluginRoute("phantom:read", async (req, res, plugin) => {
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-phantom") apiError(403, "LegacyX Phantom plugin identity is required");
    const serverId = z.string().trim().min(1).max(120).parse(req.query.serverId);
    const mapName = z.string().trim().min(1).max(128).parse(req.query.mapName);
    const excludeMatchReference = z.string().trim().min(1).max(255).parse(req.query.excludeMatchReference);
    const minimumSamples = z.coerce.number().int().min(3).max(600).default(12).parse(req.query.minimumSamples);
    const { data, error } = await db().from("phantom_history_rounds").select("source_ref,match_reference,map_name,round_number,sample_count,samples,completed_at").eq("server_id", serverId).eq("map_name", mapName).neq("match_reference", excludeMatchReference).gte("sample_count", minimumSamples).order("completed_at", { ascending: false }).limit(20);
    legacyXError(error, "Unable to load Phantom history rounds");
    res.json({ rounds: data ?? [] });
  }));
  router.get("/plugin/phantom/suspensions/:steamId", pluginRoute("phantom:read", async (req, res, plugin) => {
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-phantom") apiError(403, "LegacyX Phantom plugin identity is required");
    const steamId = z.string().regex(/^\d{15,20}$/).parse(req.params.steamId);
    const serverId = z.string().trim().min(1).max(120).parse(req.query.serverId);
    const { data, error } = await db().from("phantom_suspension_cases").select("id,status,suspicion_score,evidence_count,evidence_summary,suspended_at").eq("server_id", serverId).eq("steam_id", steamId).eq("status", "SUSPENDED").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    legacyXError(error, "Unable to load Phantom suspension state");
    res.json({ suspension: data ?? null });
  }));
  router.get("/plugin/admin-policy", pluginRoute("admin:read", async (req, res, plugin) => {
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-admin") apiError(403, "LegacyX Admin plugin identity is required");

    const { data, error } = await db()
      .from("staff")
      .select("id,user_id,role,game_permissions,stamina,immunity,status,updated_at,users(username,steam_id)")
      .eq("status", "active")
      .order("updated_at", { ascending: true });
    legacyXError(error, "Unable to load in-game admin policy");

    const admins = ((data ?? []) as DbRow[]).map((member) => {
      const user = firstRow(member.users) ?? {};
      const steamId = textValue(user.steam_id);
      const gamePermissions = Array.isArray(member.game_permissions)
        ? member.game_permissions.filter((value): value is string => typeof value === "string" && inGameAdminPermissionSchema.safeParse(value).success)
        : [];
      return {
        staffId: textValue(member.id),
        steamId,
        username: textValue(user.username) || "LEGACY-X Staff",
        role: textValue(member.role),
        stamina: Math.max(0, Math.min(1000, numberValue(member.stamina) ?? staffRoleNumericDefaults[member.role as keyof typeof staffRoleNumericDefaults] ?? 0)),
        immunity: Math.max(0, Math.min(1000, numberValue(member.immunity) ?? staffRoleNumericDefaults[member.role as keyof typeof staffRoleNumericDefaults] ?? 0)),
        permissions: gamePermissions,
        updatedAt: timestampValue(member.updated_at),
      };
    }).filter((member) => /^7656\d{13,14}$/.test(member.steamId) && member.permissions.length > 0);

    const policyVersion = sha256(JSON.stringify(admins.map((member) => ({ steamId: member.steamId, stamina: member.stamina, immunity: member.immunity, permissions: member.permissions, updatedAt: member.updatedAt }))));
    res.json({ policyVersion, generatedAt: new Date().toISOString(), admins });
  }));
  /** In-game profile line (!profile): rank and EXP from the single competitive source of truth. */
  router.get("/plugin/community/players/:steamId", pluginRoute("stats:write", async (req, res) => {
    const steamId = String(req.params.steamId || "").trim();
    if (!/^\d{15,20}$/.test(steamId)) apiError(400, "steamId must be a 15-20 digit SteamID64");
    const { data, error } = await db().from("competitive_leaderboard").select("position,steam_id,username,current_exp,rank_id,rank_name,pro_league_unlocked,matches_completed,wins,losses,kd_ratio").eq("steam_id", steamId).maybeSingle();
    legacyXError(error, "Unable to load plugin player profile");
    if (!data) apiError(404, "Player profile not found");
    const row = data as DbRow;
    const progress = rankProgress(numberValue(row.current_exp) ?? STARTING_EXP);
    res.json({ profile: { ...row, next_rank_name: progress.next?.name ?? null, next_rank_min_exp: progress.next?.minimumExp ?? null } });
  }));

  // One request per player per second: a player spamming !rs cannot turn into database load.
  const skinchangerPluginLoadoutRateLimit = rateLimit({
    windowMs: 1_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : 1,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => `skinchanger-loadout:${typeof req.query.steam_id === "string" ? req.query.steam_id : "invalid"}`,
    message: { error_code: "rate_limited" },
  });

  /** Read on demand when a player types !rs. No queue and no session: the plugin applies what this returns. */
  router.get("/plugin/skinchanger/loadout", skinchangerPluginLoadoutRateLimit, pluginRoute("skinchanger:read", async (req, res, plugin) => {
    const steamId = z.string().regex(/^\d{15,20}$/).parse(req.query.steam_id);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-skinbridge") apiError(403, "LegacyX SkinBridge plugin identity is required");
    const { data: user, error } = await db().from("users").select("id").eq("steam_id", steamId).maybeSingle();
    legacyXError(error, "Unable to resolve player");
    // The plugin owns every player-facing string, so only a machine-readable code is returned.
    if (!user) {
      res.status(404).json({ error_code: "not_linked" });
      return;
    }
    const result = await loadSkinchangerLoadout(req, textValue(user.id));
    // Same entry shape the SkinBridge plugin applied from queued jobs; inactive catalog items are skipped.
    const entries = (result?.entries ?? []).flatMap((entry) => {
      const row = entry as DbRow;
      const item = entry.skinchanger_catalog_items as DbRow | null;
      if (!item) return [];
      return [{
        slot: row.slot,
        slotKey: row.slot_key,
        teamScope: row.team_scope,
        catalogItemId: item.id,
        category: item.category,
        weaponDefindex: item.weapon_defindex ?? null,
        paintId: item.paint_id ?? null,
        model: item.model ?? null,
        options: recordValue(row.options),
      }];
    });
    res.json({ entries });
  }));
  router.post("/plugin/live-match/snapshots", pluginRoute("servers:write", async (req, res, plugin) => {
    const input = z.object({ event_id: pluginEventIdSchema, server_id: z.string().trim().min(1).max(120), live_match: liveMatchSnapshotV1Schema }).strict().parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (!new Set(["legacyx-reconnect", "legacyx-live-snapshot"]).has(pluginId)) apiError(403, "Live snapshot plugin identity is required");
    const result = await ingestLiveMatchSnapshot(pluginId, input.event_id, input.server_id, input.live_match);
    await writePluginAudit(plugin, "live_match.snapshot", "server_live_match_snapshots", input.server_id, { eventId: input.event_id, snapshotRevision: input.live_match.snapshot_revision });
    res.status(200).json({ result });
  }));
  router.post("/plugin/killfeed/events", pluginRoute("servers:write", async (req, res) => {
    const events = z.union([killEventSchema, z.array(killEventSchema).min(1).max(50)]).parse(req.body);
    const accepted = (Array.isArray(events) ? events : [events]).filter(event => killFeed.add(event)).length;
    res.status(202).json({ accepted });
  }));
  router.post("/plugin/reconnect/events", pluginRoute("servers:write", async (req, res, plugin) => {
    const input = z.object({ event: z.enum(["player_connected", "player_disconnected", "server_heartbeat"]), event_id: pluginEventIdSchema, server_id: z.string().min(1).max(120), server_address: z.string().min(1).max(255), map_name: z.string().max(128).optional().default(""), mode: z.string().max(128).optional().default(""), player_count: z.coerce.number().int().min(0).max(128).optional(), max_players: z.coerce.number().int().min(1).max(128).optional(), gotv_address: z.string().trim().max(255).optional(), live_match: liveMatchSnapshotV1Schema.optional(), session_id: z.string().uuid().optional(), steam_id: z.string().regex(/^\d{15,20}$/).optional(), player_name: z.string().max(128).optional().default(""), disconnect_reason: z.string().max(96).optional().default(""), reconnect_window_minutes: z.coerce.number().int().min(5).max(1440).optional().default(720) }).strict().parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-reconnect") apiError(403, "Reconnect plugin identity is required");
    if (input.event === "server_heartbeat") {
      const { data, error } = await db().schema("legacy_x").rpc("ingest_reconnect_heartbeat", { p_event_id: input.event_id, p_plugin_id: pluginId, p_server_id: input.server_id, p_server_address: input.server_address, p_map_name: input.map_name, p_mode: input.mode, p_player_count: input.player_count ?? 0 });
      legacyXError(error, "Unable to ingest reconnect server heartbeat");
      if (input.max_players !== undefined || input.gotv_address !== undefined) {
        const capacity = await db().from("reconnect_servers").update({ max_players: input.max_players ?? null, gotv_address: input.gotv_address || null }).eq("server_id", input.server_id);
        if (capacity.error && !isMissingColumnError(capacity.error)) legacyXError(capacity.error, "Unable to store server capacity");
      }
      let liveMatch: unknown = null;
      if (input.live_match) {
        liveMatch = await ingestLiveMatchSnapshot(pluginId, input.event_id, input.server_id, input.live_match);
      }
      res.status(200).json({ result: data ?? {}, liveMatch });
      return;
    }
    if (!input.session_id || !input.steam_id) apiError(400, "session_id and steam_id are required for player reconnect events");
    const { data, error } = await db().schema("legacy_x").rpc("ingest_reconnect_event", { p_event_id: input.event_id, p_plugin_id: pluginId, p_event_type: input.event, p_session_id: input.session_id, p_steam_id: input.steam_id, p_player_name: input.player_name, p_server_id: input.server_id, p_server_address: input.server_address, p_map_name: input.map_name, p_mode: input.mode, p_disconnect_reason: input.disconnect_reason || null, p_reconnect_window_minutes: input.reconnect_window_minutes });
    legacyXError(error, "Unable to ingest reconnect player event");
    res.status(200).json({ result: data ?? {} });
  }));
  router.get("/plugin/reconnect/players/:steamId", pluginRoute("servers:write", async (req, res) => {
    const steamId = String(req.params.steamId || "").trim();
    if (!/^\d{15,20}$/.test(steamId)) apiError(400, "steamId must be a 15-20 digit SteamID64");
    const excludedServerId = typeof req.query.exclude_server_id === "string" ? req.query.exclude_server_id.trim() : "";
    const { data, error } = await db().schema("legacy_x").from("reconnect_last_played").select("session_id,steam_id,player_name,server_id,server_name,connect_address,map_name,mode,connected_at,disconnected_at,reconnectable_until,player_count,last_heartbeat_at,server_online").eq("steam_id", steamId).order("connected_at", { ascending: false }).limit(10);
    legacyXError(error, "Unable to load reconnect sessions");
    const now = Date.now();
    res.json({ sessions: (data ?? []).filter(session => session.server_id !== excludedServerId).map(session => ({ ...session, reconnectable: session.server_online === true && new Date(session.reconnectable_until).getTime() >= now })) });
  }));

  router.use((_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  router.use((error: Error & { statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "Validation failed" });
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error("[legacy-x-api]", error);
    res.status(status).json({ error: status >= 500 ? "Unexpected server error" : (error.message || "Request failed") });
  });

  return router;
}
