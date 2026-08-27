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
  verifyAccessToken,
  verifySteamCallback,
  type LegacyUser,
  type PluginPrincipal,
} from "./auth";
import { apiAuthRateLimitMax, apiRateLimitMax, apiSensitiveRateLimitMax, isDeferredFeatureEnabled, publicDeferredFeatureFlags, type DeferredFeatureKey } from "./config";
import { getFaceitProfileSnapshot, getFaceitProfileSnapshotForSteamId, resolveFaceitNickname } from "./faceit";
import { legacyXDb, legacyXError } from "./supabase";
import { resolvePublicSteamBackground } from "./steamBackground";
import { syncSteamUserProfile } from "./steamProfile";

type ApiRequest = Request & { legacyUser?: LegacyUser; plugin?: PluginPrincipal };
type AsyncHandler = (req: ApiRequest, res: Response, next: NextFunction) => Promise<void>;

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
const leaderboardSchema = pageSchema.extend({ sort: z.enum(["rating", "kd_ratio", "experience"]).default("rating") });

function apiError(statusCode: number, message: string): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  throw error;
}

function asyncRoute(handler: AsyncHandler) {
  return (req: ApiRequest, res: Response, next: NextFunction) => void handler(req, res, next).catch(next);
}

function bearer(req: Request) {
  const value = req.header("authorization");
  if (value?.startsWith("Bearer ")) return value.slice(7).trim();
  const cookieToken = parseCookieHeader(req.headers.cookie ?? "").legacyx_access_token;
  if (cookieToken) return cookieToken;
  apiError(401, "Bearer token is required");
}

function pluginCredential(req: Request) {
  const value = req.header("authorization");
  if (value?.startsWith("Bearer ")) return value.slice(7).trim();
  const legacyHeader = req.header("x-plugin-secret")?.trim();
  if (legacyHeader) return legacyHeader;
  apiError(401, "Plugin credential is required");
}

function refreshTokenFromRequest(req: Request) {
  const input = z.object({ refreshToken: z.string().min(20).optional() }).parse(req.body ?? {});
  return input.refreshToken ?? parseCookieHeader(req.headers.cookie ?? "").legacyx_refresh_token ?? apiError(401, "Refresh token is required");
}

async function requireUser(req: ApiRequest) {
  const user = await verifyAccessToken(bearer(req));
  req.legacyUser = user;
  return user;
}

function userRoute(handler: (req: ApiRequest, res: Response, user: LegacyUser) => Promise<void>) {
  return asyncRoute(async (req, res) => handler(req, res, await requireUser(req)));
}

function staffRoute(handler: (req: ApiRequest, res: Response, user: LegacyUser) => Promise<void>) {
  return userRoute(async (req, res, user) => {
    const { data: staff, error } = await legacyXDb().from("staff").select("id").eq("user_id", user.id).eq("status", "active").maybeSingle();
    legacyXError(error, "Unable to verify staff access");
    if (!staff) apiError(403, "Staff access is required");
    await handler(req, res, user);
  });
}

async function requireOwnerStaffRole(userId: string) {
  const { data: staff, error } = await legacyXDb().from("staff").select("role").eq("user_id", userId).eq("status", "active").maybeSingle();
  legacyXError(error, "Unable to verify Owner staff access");
  if (!staff || staff.role !== "OWNER") apiError(403, "Only an Owner can perform this operation");
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
    .select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level,created_at,updated_at,player_stats(*)")
    .eq("id", id)
    .maybeSingle();
  legacyXError(error, "Unable to load player");
  if (!data) apiError(404, "Player was not found");
  return data;
}

function sendPage(res: Response, data: unknown, count: number | null, limit: number, offset: number) {
  res.json({ data, pagination: { limit, offset, total: count ?? 0 } });
}

function staticStorageUrl(req: Request, key: string | null | undefined) {
  if (!key) return null;
  // Catalog image_key is an API-owned object-storage key, never an external URL.
  // Rejecting legacy absolute keys prevents third-party origins (including Akamai)
  // from leaking into browser requests or frontend source inspection.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(key)) return null;
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

const profileUpdateSchema = z.object({ username: z.string().trim().min(2).max(64).optional(), avatar: z.string().max(2048).optional() });
const faceitLinkSchema = z.object({ nickname: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "FACEIT nickname contains unsupported characters") });
const linksSchema = z.object({ links: z.array(z.string().url().max(2048)).max(20) });
const clanSchema = z.object({ name: z.string().trim().min(2).max(64), tag: z.string().trim().min(1).max(6), logo: z.string().max(2048).optional(), thumbnail: z.string().url().max(2048).optional(), description: z.string().max(2000).optional(), region: z.string().trim().min(2).max(64).optional(), maxPlayers: z.number().int().min(1).max(100).optional() });
const feedbackSchema = z.object({ name: z.string().trim().min(1).max(64).optional(), rating: z.number().int().min(1).max(5), message: z.string().trim().min(1).max(4000) });
const pluginServerSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), map: z.string().trim().min(1).max(64), mode: z.string().trim().min(1).max(64), max_players: z.number().int().min(0).max(256), current_players: z.number().int().min(0).max(256), ping: z.number().int().min(0).max(10000).default(0), status: z.enum(["online", "offline", "full"]), ip_address: z.string().max(255).optional(), port: z.number().int().min(1).max(65535).optional() });
const pluginMatchSchema = z.object({ id: z.string().uuid().optional(), server_id: z.string().uuid().optional(), map: z.string().trim().min(1).max(64), mode: z.enum(["5vs5", "fun", "proleague", "tournaments"]), number: z.number().int().min(0), status: z.enum(["live", "waiting", "finished", "locked"]).default("waiting"), players: z.number().int().min(0).max(256).default(0), max_players: z.number().int().min(1).max(256).default(10), score_t: z.number().int().min(0).default(0), score_ct: z.number().int().min(0).default(0), signal: z.number().int().min(0).default(0) });
const pluginHistorySchema = z.object({ user_id: z.string().uuid(), match_id: z.string().uuid().optional(), map: z.string().trim().min(1).max(64), result: z.enum(["Win", "Loss"]), score: z.string().trim().min(1).max(32), kd: z.string().trim().min(1).max(32), stats: z.object({ matches: z.number().int().min(0), wins: z.number().int().min(0), kills: z.number().int().min(0), deaths: z.number().int().min(0), headshots: z.number().int().min(0), kd_ratio: z.number().min(0), rating: z.number().min(0), experience: z.number().int().min(0), played_hours: z.number().min(0) }).optional() });
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
const playModeSchema = z.enum(["5vs5", "fun", "proleague", "tournaments"]);
const matchStatusSchema = z.enum(["live", "waiting", "finished", "locked"]);
const serverStatusSchema = z.enum(["online", "offline", "full"]);
const tournamentMatchStatusSchema = z.enum(["live", "upcoming", "completed"]);
const penaltyTypeSchema = z.enum(["ban", "comm", "gag"]);
const userRoleSchema = z.enum(["Owner", "Founder", "Manager", "Admin", "Player", "Designer", "Developer"]);
const shopRaritySchema = z.enum(["Common", "Rare", "Epic", "Legendary"]);
const promoOwnerKindSchema = z.enum(["legacyx", "creator", "partner"]);
const promoBenefitTypeSchema = z.enum(["wallet_credit", "wallet_rate_override", "wallet_percent", "wallet_fixed", "store_percent", "store_fixed", "admin_role"]);
const promoContextSchema = z.enum(["wallet_topup", "wallet_redeem", "store_purchase"]);
const promoCodeSchema = z.string().trim().min(6).max(48).regex(/^[A-Za-z0-9-]+$/, "Promo code can only contain letters, numbers and hyphens");
const staffPanelServerSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const staffPanelMapSchema = z.enum(["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"]);
const staffPanelProductSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(64),
  price: z.number().int().min(0).max(1_000_000),
  image: z.string().trim().url().max(1024).optional().default(""),
  rarity: shopRaritySchema,
});
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
const promoPreviewSchema = z.object({
  code: promoCodeSchema,
  context: promoContextSchema,
  coinAmount: z.number().int().min(1).max(1_000_000).optional(),
  itemId: userIdSchema.optional(),
}).strict();
const promoRedeemSchema = z.object({
  code: promoCodeSchema,
  idempotencyKey: z.string().trim().min(8).max(96).regex(/^[A-Za-z0-9:_-]+$/).optional(),
}).strict();
const promoCampaignCreateSchema = z.object({
  name: z.string().trim().min(3).max(96),
  ownerKind: promoOwnerKindSchema,
  ownerUserId: userIdSchema.optional().nullable(),
  benefitType: promoBenefitTypeSchema,
  benefitValue: z.number().int().min(0).max(1_000_000),
  startsAt: z.string().datetime({ offset: true }).optional().nullable(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  maxRedemptions: z.number().int().min(1).max(10_000_000).optional().nullable(),
  perUserLimit: z.number().int().min(1).max(100).default(1),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({}),
}).strict().superRefine((input, context) => {
  if ((input.ownerKind === "creator" || input.ownerKind === "partner") && !input.ownerUserId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerUserId"], message: "Creator and partner campaigns require an owner user" });
  }
  if (input.startsAt && input.expiresAt && new Date(input.expiresAt).getTime() <= new Date(input.startsAt).getTime()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "Expiry must be after campaign start" });
  }
  if ((input.benefitType === "wallet_percent" || input.benefitType === "store_percent") && input.benefitValue > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["benefitValue"], message: "Percentage discount cannot exceed 100" });
  }
  if (input.benefitType === "wallet_rate_override" && input.benefitValue < 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["benefitValue"], message: "Wallet rate must be at least 1₮ per coin" });
  }
});
const promoCodeCreateSchema = z.object({
  code: promoCodeSchema.optional(),
  maxRedemptions: z.number().int().min(1).max(10_000_000).optional().nullable(),
  perUserLimit: z.number().int().min(1).max(100).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }).optional().nullable(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
}).strict();
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
const skinchangerApplySchema = z.object({ serverId: z.string().trim().min(1).max(120) });
const skinchangerPluginSessionSchema = z.object({
  eventId: z.string().min(8).max(180),
  event: z.enum(["session_connected", "session_heartbeat", "session_disconnected"]),
  serverId: z.string().trim().min(1).max(120),
  steamId: z.string().regex(/^\d{15,20}$/),
  playerName: z.string().trim().max(128).optional().default(""),
});
const skinchangerPluginAckSchema = z.object({
  leaseToken: z.string().uuid(),
  status: z.enum(["applied", "failed"]),
  failureCode: z.string().trim().min(1).max(64).optional(),
  failureDetail: z.string().trim().max(256).optional(),
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

function statsRow(user: DbRow) {
  return firstRow(user.player_stats) ?? {};
}

function mapUserProfile(user: DbRow, links: DbRow[] = []) {
  const profile: Record<string, unknown> = {
    id: textValue(user.id),
    steamId: textValue(user.steam_id),
    username: textValue(user.username),
    avatar: textValue(user.avatar),
    level: numberValue(user.level),
    rank: textValue(user.rank),
    balance: numberValue(user.balance),
  };
  if (user.faceit_username && user.faceit_elo != null && user.faceit_level != null) {
    profile.faceit = { username: textValue(user.faceit_username), elo: numberValue(user.faceit_elo), level: numberValue(user.faceit_level) };
  }
  profile.links = links.map(link => ({ url: textValue(link.url) }));
  return profile;
}

function mapProfileStats(stats: DbRow) {
  return { matches: numberValue(stats.matches), wins: numberValue(stats.wins), kdRatio: numberValue(stats.kd_ratio), rating: numberValue(stats.rating) };
}

function mapRecentMatch(match: DbRow) {
  return { map: textValue(match.map), result: textValue(match.result) as "Win" | "Loss", score: textValue(match.score), kd: textValue(match.kd) };
}

function mapServer(server: DbRow) {
  return { id: textValue(server.id), name: textValue(server.name), map: textValue(server.map), players: numberValue(server.current_players), maxPlayers: numberValue(server.max_players), mode: textValue(server.mode), ping: numberValue(server.ping), status: textValue(server.status) };
}

function mapMatch(match: DbRow, favorite = false) {
  return { id: textValue(match.id), number: numberValue(match.number), map: textValue(match.map), players: numberValue(match.players), maxPlayers: numberValue(match.max_players), status: textValue(match.status), favorite, signal: numberValue(match.signal), scoreT: numberValue(match.score_t), scoreCT: numberValue(match.score_ct) };
}

type ModerationStatus = "Banned" | "Muted" | "Clear";

function mapLeader(stats: DbRow, index: number, moderationStatuses: Map<string, ModerationStatus> = new Map()) {
  const user = firstRow(stats.users) ?? {};
  const userId = textValue(user.id || stats.user_id);
  return { id: userId, steamId: textValue(user.steam_id), rank: index + 1, name: textValue(user.username), level: numberValue(user.level), experience: numberValue(stats.experience), kills: numberValue(stats.kills), deaths: numberValue(stats.deaths), kd: numberValue(stats.kd_ratio), headshots: numberValue(stats.headshots), playedHours: numberValue(stats.played_hours), lastPlayed: timestampValue(stats.last_played_at), avatar: textValue(user.avatar), moderationStatus: moderationStatuses.get(userId) ?? "Clear" };
}

function mapLeaderFromUser(user: DbRow, index: number) {
  const stats = statsRow(user);
  return { id: textValue(user.id), steamId: textValue(user.steam_id), rank: index + 1, name: textValue(user.username), level: numberValue(user.level), experience: numberValue(stats.experience), kills: numberValue(stats.kills), deaths: numberValue(stats.deaths), kd: numberValue(stats.kd_ratio), headshots: numberValue(stats.headshots), playedHours: numberValue(stats.played_hours), lastPlayed: timestampValue(stats.last_played_at), avatar: textValue(user.avatar) };
}

function memberCount(clan: DbRow) {
  const countRelation = firstRow(clan.clan_members);
  return numberValue(countRelation?.count);
}

function mapClanCard(clan: DbRow, currentPlayers = memberCount(clan)) {
  return { id: textValue(clan.id), name: textValue(clan.name), tag: textValue(clan.tag), logo: textValue(clan.logo), thumbnail: clan.thumbnail == null ? null : textValue(clan.thumbnail), currentPlayers, maxPlayers: numberValue(clan.max_players), region: textValue(clan.region) };
}

function mapClanMember(member: DbRow) {
  const user = firstRow(member.users) ?? {};
  return { id: textValue(user.id || member.user_id), steamId: textValue(user.steam_id), name: textValue(user.username), role: textValue(member.role), avatar: textValue(user.avatar), description: "" };
}

function mapTournamentMatch(match: DbRow) {
  return { id: textValue(match.id), teamA: textValue(match.team_a), teamB: textValue(match.team_b), round: textValue(match.round), map: textValue(match.map), time: textValue(match.scheduled_time), score: match.score == null ? null : textValue(match.score), status: textValue(match.status) };
}

function mapShopItem(item: DbRow) {
  return { id: textValue(item.id), name: textValue(item.name), category: textValue(item.category), price: numberValue(item.price), image: textValue(item.image), rarity: textValue(item.rarity) };
}

function mapWalletTransaction(transaction: DbRow) {
  const type = textValue(transaction.type);
  return { id: textValue(transaction.id), type: type === "charge" ? "Charge" : "Purchase", amount: numberValue(transaction.amount), method: textValue(transaction.method), date: timestampValue(transaction.created_at) };
}

function normalizePromoCode(code: string) {
  return promoCodeSchema.parse(code).replace(/-/g, "").toUpperCase();
}

function promoCodeHint(code: string) {
  return `${code.slice(0, 3)}•••${code.slice(-3)}`;
}

function generatedPromoCode() {
  const token = randomBytes(8).toString("hex").toUpperCase();
  return `LX-${token.slice(0, 4)}-${token.slice(4, 8)}-${token.slice(8, 12)}-${token.slice(12)}`;
}

function mapPromotionCampaign(row: DbRow) {
  return {
    id: textValue(row.id), name: textValue(row.name), ownerKind: textValue(row.owner_kind), ownerUserId: row.owner_user_id == null ? null : textValue(row.owner_user_id),
    benefitType: textValue(row.benefit_type), benefitValue: numberValue(row.benefit_value), startsAt: row.starts_at == null ? null : timestampValue(row.starts_at),
    expiresAt: row.expires_at == null ? null : timestampValue(row.expires_at), maxRedemptions: row.max_redemptions == null ? null : numberValue(row.max_redemptions),
    redemptionCount: numberValue(row.redemption_count), perUserLimit: numberValue(row.per_user_limit), isActive: Boolean(row.is_active), createdAt: timestampValue(row.created_at),
  };
}

function mapPromotionCode(row: DbRow) {
  return {
    id: textValue(row.id), campaignId: textValue(row.campaign_id), hint: textValue(row.code_hint), maxRedemptions: row.max_redemptions == null ? null : numberValue(row.max_redemptions),
    redemptionCount: numberValue(row.redemption_count), perUserLimit: row.per_user_limit == null ? null : numberValue(row.per_user_limit), startsAt: row.starts_at == null ? null : timestampValue(row.starts_at),
    expiresAt: row.expires_at == null ? null : timestampValue(row.expires_at), isActive: Boolean(row.is_active), createdAt: timestampValue(row.created_at),
  };
}

function mapPenalty(penalty: DbRow, adminSteamIds: Map<string, string> = new Map(), moderationStatuses: Map<string, ModerationStatus> = new Map()) {
  const user = firstRow(penalty.users) ?? {};
  const admin = textValue(penalty.admin_name);
  const userId = textValue(user.id || penalty.user_id);
  return { id: textValue(penalty.id), type: textValue(penalty.type), player: textValue(user.username), playerSteamId: textValue(user.steam_id) || undefined, avatar: textValue(user.avatar), moderationStatus: moderationStatuses.get(userId) ?? "Clear", reason: textValue(penalty.reason), term: textValue(penalty.term), isPermanent: Boolean(penalty.is_permanent), isUnbanned: Boolean(penalty.is_unbanned), admin, adminSteamId: adminSteamIds.get(admin) || undefined, date: timestampValue(penalty.created_at) };
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

async function mapPenaltiesWithProfileIdentities(rows: DbRow[], database: ReturnType<typeof legacyXDb>) {
  const adminNames = Array.from(new Set(rows.map(row => textValue(row.admin_name)).filter(Boolean)));
  const adminSteamIds = new Map<string, string>();
  if (adminNames.length) {
    const { data, error } = await database.from("users").select("username,steam_id").in("username", adminNames);
    legacyXError(error, "Unable to resolve penalty issuer profiles");
    for (const user of (data ?? []) as DbRow[]) adminSteamIds.set(textValue(user.username), textValue(user.steam_id));
  }
  const moderationStatuses = await resolveModerationStatuses(rows.map(row => textValue(row.user_id)), database);
  return rows.map(row => mapPenalty(row, adminSteamIds, moderationStatuses));
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
  if (path.startsWith("/staff/promotions")) return "promoCodes";
  if (path.startsWith("/wallet/promo") || path.startsWith("/wallet/promotions")) return "promoCodes";
  if (path.startsWith("/wallet")) return "wallet";
  if (path.startsWith("/credits")) return "credits";
  if (path.startsWith("/store") || path.startsWith("/shop")) return "shop";
  if (path.startsWith("/clans") || path.startsWith("/clan")) return "clan";
  if (path === "/search/clans") return "clan";
  return null;
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
  const loadProfile = async (id: string) => {
    const [userResult, linksResult] = await Promise.all([
      db().from("users").select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level,player_stats(*)").eq("id", id).maybeSingle(),
      db().from("user_links").select("url").eq("user_id", id).order("created_at"),
    ]);
    legacyXError(userResult.error || linksResult.error, "Unable to load profile");
    if (!userResult.data) apiError(404, "Player was not found");
    return { user: userResult.data as DbRow, links: (linksResult.data ?? []) as DbRow[] };
  };
  const loadClanDetail = async (clanId: string) => {
    const [clanResult, membersResult] = await Promise.all([
      db().from("clans").select("*,clan_members(count)").eq("id", clanId).maybeSingle(),
      db().from("clan_members").select("role,user_id,users(id,steam_id,username,avatar)").eq("clan_id", clanId).order("created_at"),
    ]);
    legacyXError(clanResult.error || membersResult.error, "Unable to load clan");
    if (!clanResult.data) apiError(404, "Clan was not found");
    const clan = clanResult.data as DbRow;
    return { ...mapClanCard(clan), description: clan.description ?? undefined, members: ((membersResult.data ?? []) as DbRow[]).map(mapClanMember) };
  };
  const loadActiveTournament = async () => {
    const { data, error } = await db().from("tournaments").select("*").in("status", ["active", "upcoming"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    legacyXError(error, "Unable to load active tournament");
    if (!data) apiError(404, "No active tournament was found");
    return data as DbRow;
  };

  // Public website reads deliberately bypass AdminPlus. CS2 plugins/admin tools
  // write to Supabase; the website reads these safe projections through root API.
  const readLimit = (value: unknown) => z.coerce.number().int().min(1).max(100).default(50).parse(value);
  const readSeason = (value: unknown) => {
    const season = String(value || process.env.LEGACYX_DEFAULT_SEASON || "season-1").trim();
    if (!/^[a-z0-9-]{1,64}$/i.test(season)) apiError(400, "season is invalid");
    return season;
  };
  const readServers = async () => {
    const { data, error } = await db().from("reconnect_servers").select("server_id,connect_address,display_name,current_map,current_mode,player_count,last_heartbeat_at").order("display_name").limit(100);
    legacyXError(error, "Unable to load public servers");
    return ((data ?? []) as DbRow[]).map(server => {
      const heartbeat = new Date(String(server.last_heartbeat_at ?? "")).getTime();
      const players = numberValue(server.player_count);
      const online = Number.isFinite(heartbeat) && Date.now() - heartbeat <= 90_000;
      return { id: textValue(server.server_id), name: textValue(server.display_name) || textValue(server.server_id), map: textValue(server.current_map) || "Unknown", players, maxPlayers: 10, mode: textValue(server.current_mode) || "Community", ping: 0, status: online ? (players >= 10 ? "full" : "online") : "offline", connectAddress: textValue(server.connect_address) };
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
  router.get("/public/rank/leaderboard", asyncRoute(async (req, res) => {
    const season = readSeason(req.query.season);
    const { data, error } = await db().from("rank_leaderboard").select("season_slug,season_name,rank,steam_id,username,rating,tier,matches_played,wins,losses,kills,deaths,assists,kd_ratio,last_match_at").eq("season_slug", season).order("rank").limit(readLimit(req.query.limit));
    legacyXError(error, "Unable to load public rank leaderboard");
    res.json({ season, entries: data ?? [] });
  }));
  router.get("/public/community/experience", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("community_experience_leaderboard").select("rank,steam_id,username,level,experience,matches_played,last_match_at").order("rank").limit(readLimit(req.query.limit));
    legacyXError(error, "Unable to load public experience leaderboard");
    res.json({ entries: data ?? [] });
  }));
  router.get("/public/competitive/leaderboard", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("competitive_leaderboard").select("position,user_id,steam_id,username,avatar,current_exp,rank_id,rank_slug,rank_name,rank_image_key,pro_league_unlocked,matches_completed,wins,losses,kills,assists,headshot_kills,deaths,kd_ratio,played_hours,last_match_at").order("position").limit(readLimit(req.query.limit));
    legacyXError(error, "Unable to load competitive leaderboard");
    res.json({ entries: data ?? [] });
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
  router.get("/public/competitive/players/:userId", asyncRoute(async (req, res) => {
    const userId = userIdSchema.parse(req.params.userId);
    const profileColumns = "user_id,steam_id,username,avatar,current_exp,rank_id,rank_slug,rank_name,rank_image_key,pro_league_unlocked,matches_completed,wins,losses,kills,assists,headshot_kills,last_match_at,current_rank_min_exp,next_rank_id,next_rank_name,next_rank_min_exp";
    const { data, error } = await db().from("competitive_player_profiles").select(profileColumns).eq("user_id", userId).maybeSingle();
    legacyXError(error, "Unable to load competitive player profile");
    if (data) {
      res.json({ profile: data });
      return;
    }

    const [{ data: user, error: userError }, { data: definitions, error: definitionError }] = await Promise.all([
      db().from("users").select("id,steam_id,username,avatar").eq("id", userId).maybeSingle(),
      db().from("competitive_rank_definitions").select("rank_id,slug,display_name,image_key,minimum_exp").in("rank_id", [1, 2]).order("rank_id"),
    ]);
    legacyXError(userError, "Unable to load competitive player");
    legacyXError(definitionError, "Unable to load competitive rank definitions");
    if (!user) apiError(404, "Competitive player profile was not found");
    const silverOne = definitions?.find((definition) => definition.rank_id === 1);
    const silverTwo = definitions?.find((definition) => definition.rank_id === 2);
    if (!silverOne || !silverTwo) apiError(500, "Competitive rank definitions are unavailable");
    res.json({ profile: {
      user_id: user.id,
      steam_id: user.steam_id,
      username: user.username,
      avatar: user.avatar,
      current_exp: 0,
      rank_id: silverOne.rank_id,
      rank_slug: silverOne.slug,
      rank_name: silverOne.display_name,
      rank_image_key: silverOne.image_key,
      pro_league_unlocked: false,
      matches_completed: 0,
      wins: 0,
      losses: 0,
      kills: 0,
      assists: 0,
      headshot_kills: 0,
      last_match_at: null,
      current_rank_min_exp: silverOne.minimum_exp,
      next_rank_id: silverTwo.rank_id,
      next_rank_name: silverTwo.display_name,
      next_rank_min_exp: silverTwo.minimum_exp,
    } });
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
  router.get("/public/overview", asyncRoute(async (_req, res) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [servers, clans, matches] = await Promise.all([
      readServers(),
      db().from("community_clan_leaderboard").select("clan_id").eq("season_slug", readSeason(undefined)).limit(100),
      db().from("core_match_history").select("match_id").gte("started_at", today.toISOString()).limit(1_000),
    ]);
    legacyXError(clans.error || matches.error, "Unable to load public overview");
    const online = servers.filter(server => server.status !== "offline");
    res.json({ playersOnline: online.reduce((total, server) => total + server.players, 0), liveServers: online.length, matchesToday: (matches.data ?? []).length, activeClans: (clans.data ?? []).length });
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
    payload.steamBackground = await resolvePublicSteamBackground(textValue(profile.user.steam_id));
    res.json(payload);
  }));
  router.put("/profile/me", userRoute(async (req, res, user) => {
    const updates = profileUpdateSchema.parse(req.body);
    if (Object.keys(updates).length === 0) apiError(400, "At least one profile field is required");
    const { error } = await db().from("users").update(updates).eq("id", user.id);
    legacyXError(error, "Unable to update profile");
    const profile = await loadProfile(user.id);
    res.json(mapUserProfile(profile.user, profile.links));
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
    const { data, error } = await db().from("player_match_history").select("map,result,score,kd").eq("user_id", userId).order("created_at", { ascending: false });
    legacyXError(error, "Unable to load match history");
    res.json(((data ?? []) as DbRow[]).map(mapRecentMatch));
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

  router.get("/skinchanger/loadout", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("skinchanger_loadouts")
      .select("version,updated_at")
      .eq("user_id", user.id)
      .maybeSingle();
    legacyXError(error, "Unable to load skinchanger loadout");
    if (!data) {
      res.json({ loadout: { version: 0, updated_at: null, skinchanger_loadout_entries: [] } });
      return;
    }
    const loadout = data as DbRow;
    const { data: entryData, error: entryError } = await db().from("skinchanger_loadout_entries")
      .select("catalog_item_id,slot,slot_key,team_scope,options")
      .eq("user_id", user.id)
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
      return { ...item, image_url: staticStorageUrl(_req, textValue(item.image_key) || null) };
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
    res.json({ loadout: { ...loadout, skinchanger_loadout_entries: enrichedEntries } });
  }));

  router.get("/skinchanger/active-server", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("skinchanger_server_sessions")
      .select("server_id,player_name,connected_at,last_seen_at")
      .eq("user_id", user.id)
      .is("disconnected_at", null)
      .gte("last_seen_at", new Date(Date.now() - 90_000).toISOString())
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    legacyXError(error, "Unable to load active skinchanger server");
    res.json({ session: data ?? null });
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

  router.post("/skinchanger/apply", userRoute(async (req, res, user) => {
    const input = skinchangerApplySchema.parse(req.body);
    const { data: jobId, error } = await db().rpc("queue_skinchanger_apply", { p_user_id: user.id, p_server_id: input.serverId });
    legacyXError(error, "Unable to queue skinchanger apply");
    const { error: auditError } = await db().from("audit_logs").insert({
      actor_type: "user",
      actor_id: user.id,
      action: "skinchanger.apply.queue",
      target_type: "skinchanger_apply_jobs",
      target_id: textValue(jobId),
      metadata: { serverId: input.serverId },
    });
    legacyXError(auditError, "Unable to audit skinchanger apply");
    res.status(202).json({ jobId, status: "queued" });
  }));

  router.get("/skinchanger/status", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("skinchanger_apply_jobs")
      .select("id,server_id,loadout_version,status,attempts,failure_code,created_at,applied_at,updated_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);
    legacyXError(error, "Unable to load skinchanger job status");
    res.json({ jobs: data ?? [] });
  }));

  const frontendMatches = userRoute(async (req, res, user) => {
    const filters = z.object({ mode: playModeSchema.optional(), status: matchStatusSchema.optional() }).parse(req.query);
    let query = db().from("matches").select("*").order("number");
    if (filters.mode) query = query.eq("mode", filters.mode);
    if (filters.status) query = query.eq("status", filters.status);
    const [matchesResult, favoritesResult] = await Promise.all([query, db().from("match_favorites").select("match_id").eq("user_id", user.id)]);
    legacyXError(matchesResult.error || favoritesResult.error, "Unable to load matches");
    const favorites = new Set(((favoritesResult.data ?? []) as DbRow[]).map(row => textValue(row.match_id)));
    res.json(((matchesResult.data ?? []) as DbRow[]).map(match => mapMatch(match, favorites.has(textValue(match.id)))));
  });
  router.get("/play/matches", frontendMatches);
  router.get("/play/matches/:matchId", userRoute(async (req, res, user) => {
    const matchId = userIdSchema.parse(req.params.matchId);
    const [matchResult, favoriteResult] = await Promise.all([db().from("matches").select("*").eq("id", matchId).maybeSingle(), db().from("match_favorites").select("id").eq("match_id", matchId).eq("user_id", user.id).maybeSingle()]);
    legacyXError(matchResult.error || favoriteResult.error, "Unable to load match");
    if (!matchResult.data) apiError(404, "Match was not found");
    res.json(mapMatch(matchResult.data as DbRow, Boolean(favoriteResult.data)));
  }));
  router.post("/play/matches/:matchId/join", userRoute(async (req, res, user) => {
    noBody(req);
    const matchId = userIdSchema.parse(req.params.matchId);
    const { data, error } = await db().from("matches").select("status,players,max_players,server_id").eq("id", matchId).maybeSingle();
    legacyXError(error, "Unable to resolve match");
    if (!data) apiError(404, "Match was not found");
    if (data.status === "locked" || data.status === "finished" || data.players >= data.max_players) apiError(409, "Match is not joinable");
    const { error: auditError } = await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "match.join", target_type: "matches", target_id: matchId, metadata: { serverId: data.server_id } });
    legacyXError(auditError, "Unable to record match join");
    res.status(204).end();
  }));
  router.post("/play/matches/:matchId/favorite", userRoute(async (req, res, user) => {
    const input = z.object({ favorite: z.boolean() }).parse(req.body);
    const matchId = userIdSchema.parse(req.params.matchId);
    const { data: match, error: matchError } = await db().from("matches").select("*").eq("id", matchId).maybeSingle();
    legacyXError(matchError, "Unable to load match");
    if (!match) apiError(404, "Match was not found");
    if (input.favorite) {
      const { error } = await db().from("match_favorites").upsert({ user_id: user.id, match_id: matchId }, { onConflict: "user_id,match_id" });
      legacyXError(error, "Unable to favorite match");
    } else {
      const { error } = await db().from("match_favorites").delete().eq("user_id", user.id).eq("match_id", matchId);
      legacyXError(error, "Unable to remove match favorite");
    }
    res.json(mapMatch(match as DbRow, input.favorite));
  }));

  router.get("/servers", userRoute(async (req, res) => {
    const filters = z.object({ mode: z.string().trim().min(1).max(64).optional(), status: serverStatusSchema.optional() }).parse(req.query);
    let query = db().from("game_servers").select("*").order("name");
    if (filters.mode) query = query.eq("mode", filters.mode);
    if (filters.status) query = query.eq("status", filters.status);
    const { data, error } = await query;
    legacyXError(error, "Unable to load servers");
    res.json(((data ?? []) as DbRow[]).map(mapServer));
  }));
  router.get("/servers/home-stats", userRoute(async (_req, res) => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [servers, matches, clans] = await Promise.all([
      db().from("game_servers").select("current_players,status"),
      db().from("matches").select("id", { count: "exact", head: true }).gte("created_at", dayStart.toISOString()),
      db().from("clans").select("id", { count: "exact", head: true }),
    ]);
    legacyXError(servers.error || matches.error || clans.error, "Unable to load home statistics");
    const rows = (servers.data ?? []) as DbRow[];
    res.json({ playersOnline: rows.filter(server => server.status === "online" || server.status === "full").reduce((total, server) => total + numberValue(server.current_players), 0), liveServers: rows.filter(server => server.status === "online" || server.status === "full").length, matchesToday: matches.count ?? 0, activeClans: clans.count ?? 0 });
  }));
  router.get("/servers/:serverId", userRoute(async (req, res) => {
    const { data, error } = await db().from("game_servers").select("*").eq("id", userIdSchema.parse(req.params.serverId)).maybeSingle();
    legacyXError(error, "Unable to load server");
    if (!data) apiError(404, "Server was not found");
    res.json(mapServer(data as DbRow));
  }));
  router.post("/servers/:serverId/join", userRoute(async (req, res) => {
    noBody(req);
    const { data, error } = await db().from("game_servers").select("id,status,ip_address,port").eq("id", userIdSchema.parse(req.params.serverId)).maybeSingle();
    legacyXError(error, "Unable to load server connection");
    if (!data) apiError(404, "Server was not found");
    if (!data.ip_address || !data.port || data.status === "offline") apiError(409, "Server is not currently joinable");
    res.status(204).end();
  }));

  const frontendLeaderboard = userRoute(async (req, res) => {
    z.object({ mode: playModeSchema.optional(), region: z.string().trim().min(1).max(64).optional() }).parse(req.query);
    const { data, error } = await db().from("player_stats").select("*,users!inner(id,steam_id,username,avatar,level)").order("rating", { ascending: false });
    legacyXError(error, "Unable to load leaderboard");
    const rows = (data ?? []) as DbRow[];
    const moderationStatuses = await resolveModerationStatuses(rows.map(row => textValue(row.user_id)), db());
    res.json(rows.map((row, index) => mapLeader(row, index, moderationStatuses)));
  });
  router.get("/leaderboard", frontendLeaderboard);
  router.get("/players/leaderboard", frontendLeaderboard);
  router.get("/players/:playerId", userRoute(async (req, res) => {
    const playerId = userIdSchema.parse(req.params.playerId);
    const { data, error } = await db().from("player_stats").select("*,users!inner(id,steam_id,username,avatar,level)").order("rating", { ascending: false });
    legacyXError(error, "Unable to load player");
    const rows = (data ?? []) as DbRow[];
    const index = rows.findIndex(row => textValue(row.user_id) === playerId);
    if (index < 0) apiError(404, "Player was not found");
    const moderationStatuses = await resolveModerationStatuses([textValue(rows[index]!.user_id)], db());
    res.json(mapLeader(rows[index]!, index, moderationStatuses));
  }));

  router.get("/clans", userRoute(async (_req, res) => {
    const { data, error } = await db().from("clans").select("*,clan_members(count)").order("created_at", { ascending: false });
    legacyXError(error, "Unable to load clans");
    res.json(((data ?? []) as DbRow[]).map(mapClanCard));
  }));
  router.get("/clans/team", userRoute(async (_req, res) => {
    const { data, error } = await db().from("staff_team").select("name,role,avatar,description").order("display_order");
    legacyXError(error, "Unable to load staff team");
    res.json((data ?? []).map((member: DbRow) => ({ name: textValue(member.name), role: textValue(member.role), avatar: textValue(member.avatar), description: textValue(member.description) })));
  }));
  router.get("/clans/:clanId", userRoute(async (req, res) => {
    res.json(await loadClanDetail(userIdSchema.parse(req.params.clanId)));
  }));
  router.get("/clans/:clanId/members", userRoute(async (req, res) => {
    const clanId = userIdSchema.parse(req.params.clanId);
    const { data: clan, error: clanError } = await db().from("clans").select("id").eq("id", clanId).maybeSingle();
    legacyXError(clanError, "Unable to load clan");
    if (!clan) apiError(404, "Clan was not found");
    const { data, error } = await db().from("clan_members").select("role,user_id,users(id,username,avatar)").eq("clan_id", clanId).order("created_at");
    legacyXError(error, "Unable to load clan members");
    res.json(((data ?? []) as DbRow[]).map(mapClanMember));
  }));
  router.post("/clans", userRoute(async (req, res, user) => {
    const input = z.object({ name: z.string().trim().min(2).max(64), tag: z.string().trim().min(1).max(6), logo: z.string().max(2048), thumbnail: z.string().max(2048).nullable().optional(), region: z.string().trim().min(2).max(64).optional() }).parse(req.body);
    const { data, error } = await db().rpc("create_clan_with_leader", { p_owner_id: user.id, p_name: input.name, p_tag: input.tag, p_logo: input.logo, p_thumbnail: input.thumbnail ?? null, p_description: null, p_region: input.region ?? "Mongolia", p_max_players: 10 });
    legacyXError(error, "Unable to create clan");
    if (!data) apiError(500, "Clan was not created");
    res.status(201).json(await loadClanDetail(String(data)));
  }));
  router.put("/clans/:clanId", userRoute(async (req, res, user) => {
    const clanId = userIdSchema.parse(req.params.clanId);
    const input = z.object({ name: z.string().trim().min(2).max(64).optional(), tag: z.string().trim().min(1).max(6).optional(), logo: z.string().max(2048).optional(), thumbnail: z.string().max(2048).nullable().optional(), region: z.string().trim().min(2).max(64).optional() }).refine(value => Object.keys(value).length > 0, "At least one clan field is required").parse(req.body);
    const { data: clan, error: clanError } = await db().from("clans").select("id").eq("id", clanId).eq("owner_id", user.id).maybeSingle();
    legacyXError(clanError, "Unable to validate clan ownership");
    if (!clan) apiError(403, "Clan leader access is required");
    const { error } = await db().from("clans").update(input).eq("id", clanId);
    legacyXError(error, "Unable to update clan");
    res.json(await loadClanDetail(clanId));
  }));

  router.get("/tournaments/matches", userRoute(async (req, res) => {
    const filters = z.object({ status: tournamentMatchStatusSchema.optional() }).parse(req.query);
    let query = db().from("tournament_matches").select("*").order("bracket_order");
    if (filters.status) query = query.eq("status", filters.status);
    const { data, error } = await query;
    legacyXError(error, "Unable to load tournament matches");
    res.json(((data ?? []) as DbRow[]).map(mapTournamentMatch));
  }));
  router.get("/tournaments/matches/:matchId", userRoute(async (req, res) => {
    const { data, error } = await db().from("tournament_matches").select("*").eq("id", userIdSchema.parse(req.params.matchId)).maybeSingle();
    legacyXError(error, "Unable to load tournament match");
    if (!data) apiError(404, "Tournament match was not found");
    res.json(mapTournamentMatch(data as DbRow));
  }));
  router.get("/tournaments/bracket", userRoute(async (_req, res) => {
    const { data, error } = await db().from("tournament_matches").select("*").order("bracket_order");
    legacyXError(error, "Unable to load tournament bracket");
    const rounds = new Map<string, DbRow[]>();
    for (const match of (data ?? []) as DbRow[]) rounds.set(textValue(match.round), [...(rounds.get(textValue(match.round)) ?? []), match]);
    res.json(Array.from(rounds.entries()).map(([round, matches]) => ({ round, matches: matches.map(mapTournamentMatch) })));
  }));
  router.get("/tournaments/info", userRoute(async (_req, res) => {
    const tournament = await loadActiveTournament();
    const { count, error } = await db().from("tournament_registrations").select("id", { count: "exact", head: true }).eq("tournament_id", tournament.id);
    legacyXError(error, "Unable to count tournament registrations");
    res.json({ season: textValue(tournament.season), prizePool: textValue(tournament.prize_pool), format: textValue(tournament.format), registeredClans: count ?? 0, nextMatchTime: textValue(tournament.next_match_time) });
  }));
  router.post("/tournaments/register", userRoute(async (req, res, user) => {
    const input = z.object({ clanId: userIdSchema }).parse(req.body);
    const [tournament, clanResult] = await Promise.all([loadActiveTournament(), db().from("clans").select("id").eq("id", input.clanId).eq("owner_id", user.id).maybeSingle()]);
    legacyXError(clanResult.error, "Unable to validate clan ownership");
    if (!clanResult.data) apiError(403, "Only the clan owner can register a clan");
    const { error } = await db().from("tournament_registrations").insert({ tournament_id: tournament.id, clan_id: input.clanId });
    legacyXError(error, "Unable to register clan for tournament");
    res.status(204).end();
  }));

  router.get("/store/items", userRoute(async (req, res) => {
    const filters = z.object({ category: z.string().trim().min(1).max(64).optional(), rarity: shopRaritySchema.optional() }).parse(req.query);
    let query = db().from("store_items").select("*").order("created_at", { ascending: false });
    if (filters.category) query = query.eq("category", filters.category);
    if (filters.rarity) query = query.eq("rarity", filters.rarity);
    const { data, error } = await query;
    legacyXError(error, "Unable to load store items");
    res.json(((data ?? []) as DbRow[]).map(mapShopItem));
  }));
  router.get("/store/items/:itemId", userRoute(async (req, res) => {
    const { data, error } = await db().from("store_items").select("*").eq("id", userIdSchema.parse(req.params.itemId)).maybeSingle();
    legacyXError(error, "Unable to load store item");
    if (!data) apiError(404, "Store item was not found");
    res.json(mapShopItem(data as DbRow));
  }));
  router.post("/store/items/:itemId/purchase", userRoute(async (req, res, user) => {
    const input = z.object({ promoCode: promoCodeSchema.optional(), idempotencyKey: z.string().trim().min(8).max(96).regex(/^[A-Za-z0-9:_-]+$/).optional() }).strict().optional().parse(req.body ?? undefined);
    const { error } = await db().rpc(input?.promoCode ? "purchase_store_item_with_promotion" : "purchase_store_item", input?.promoCode
      ? { p_user_id: user.id, p_item_id: userIdSchema.parse(req.params.itemId), p_code_hash: sha256(normalizePromoCode(input.promoCode)), p_idempotency_key: input.idempotencyKey ?? null }
      : { p_user_id: user.id, p_item_id: userIdSchema.parse(req.params.itemId) });
    legacyXError(error, "Unable to complete purchase");
    res.status(204).end();
  }));
  router.get("/wallet/balance", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("users").select("balance").eq("id", user.id).maybeSingle();
    legacyXError(error, "Unable to load wallet");
    if (!data) apiError(404, "Wallet owner was not found");
    res.json({ balance: numberValue(data.balance), currency: "coins" });
  }));
  router.get("/wallet/transactions", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("wallet_transactions").select("id,type,amount,method,created_at").eq("user_id", user.id).order("created_at", { ascending: false });
    legacyXError(error, "Unable to load wallet transactions");
    res.json(((data ?? []) as DbRow[]).map(mapWalletTransaction));
  }));
  const promoRateLimit = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many promotion requests. Please try again shortly." } });
  router.post("/wallet/promo/preview", promoRateLimit, userRoute(async (req, res, user) => {
    const input = promoPreviewSchema.parse(req.body);
    const { data, error } = await db().rpc("quote_promotion_code", { p_user_id: user.id, p_code_hash: sha256(normalizePromoCode(input.code)), p_context: input.context, p_coin_amount: input.coinAmount ?? null, p_item_id: input.itemId ?? null });
    legacyXError(error, "Unable to validate promotion code");
    res.json(data);
  }));
  router.post("/wallet/promo/redeem", promoRateLimit, userRoute(async (req, res, user) => {
    const input = promoRedeemSchema.parse(req.body);
    const { data, error } = await db().rpc("redeem_promotion_code", { p_user_id: user.id, p_code_hash: sha256(normalizePromoCode(input.code)), p_idempotency_key: input.idempotencyKey ?? null });
    legacyXError(error, "Unable to redeem promotion code");
    res.status(201).json(data);
  }));
  router.get("/wallet/promotions", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("promotion_redemptions").select("id,context,status,benefit_type,benefit_value,code_hint,created_at,promotion_campaigns(name,owner_kind)").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
    legacyXError(error, "Unable to load promotion history");
    res.json((data ?? []).map((row: DbRow) => ({ id: textValue(row.id), context: textValue(row.context), status: textValue(row.status), benefitType: textValue(row.benefit_type), benefitValue: numberValue(row.benefit_value), codeHint: textValue(row.code_hint), createdAt: timestampValue(row.created_at), campaignName: textValue(firstRow(row.promotion_campaigns)?.name), ownerKind: textValue(firstRow(row.promotion_campaigns)?.owner_kind) })));
  }));
  router.get("/staff/promotions/campaigns", staffRoute(async (_req, res) => {
    const { data, error } = await db().from("promotion_campaigns").select("*").order("created_at", { ascending: false }).limit(100);
    legacyXError(error, "Unable to load promotion campaigns");
    res.json((data ?? []).map((row: DbRow) => mapPromotionCampaign(row)));
  }));
  router.post("/staff/promotions/campaigns", staffRoute(async (req, res, user) => {
    const input = promoCampaignCreateSchema.parse(req.body);
    if (input.benefitType === "admin_role") {
      if (input.ownerKind !== "legacyx") apiError(403, "Admin entitlements are reserved for LEGACY-X campaigns");
      await requireOwnerStaffRole(user.id);
    }
    const { data, error } = await db().from("promotion_campaigns").insert({ name: input.name, owner_kind: input.ownerKind, owner_user_id: input.ownerUserId ?? null, benefit_type: input.benefitType, benefit_value: input.benefitValue, starts_at: input.startsAt ?? null, expires_at: input.expiresAt ?? null, max_redemptions: input.maxRedemptions ?? null, per_user_limit: input.perUserLimit, metadata: input.metadata, created_by_user_id: user.id }).select("*").single();
    legacyXError(error, "Unable to create promotion campaign");
    await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "promotion.campaign.create", target_type: "promotion_campaign", target_id: data.id, metadata: { ownerKind: input.ownerKind, benefitType: input.benefitType } });
    res.status(201).json(mapPromotionCampaign(data as DbRow));
  }));
  router.post("/staff/promotions/campaigns/:campaignId/codes", staffRoute(async (req, res, user) => {
    const input = promoCodeCreateSchema.parse(req.body);
    const campaignId = userIdSchema.parse(req.params.campaignId);
    const { data: campaign, error: campaignError } = await db().from("promotion_campaigns").select("id,benefit_type").eq("id", campaignId).maybeSingle();
    legacyXError(campaignError, "Unable to validate promotion campaign");
    if (!campaign) apiError(404, "Promotion campaign was not found");
    if (textValue(campaign.benefit_type) === "admin_role") await requireOwnerStaffRole(user.id);
    const rawCode = input.code ? input.code.toUpperCase() : generatedPromoCode();
    const normalizedCode = normalizePromoCode(rawCode);
    const { data, error } = await db().from("promotion_codes").insert({ campaign_id: campaignId, code_hash: sha256(normalizedCode), code_hint: promoCodeHint(normalizedCode), max_redemptions: input.maxRedemptions ?? null, per_user_limit: input.perUserLimit ?? null, starts_at: input.startsAt ?? null, expires_at: input.expiresAt ?? null, created_by_user_id: user.id }).select("*").single();
    legacyXError(error, "Unable to issue promotion code");
    await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "promotion.code.issue", target_type: "promotion_code", target_id: data.id, metadata: { campaignId, codeHint: promoCodeHint(normalizedCode) } });
    res.status(201).json({ code: rawCode, promotion: mapPromotionCode(data as DbRow) });
  }));
  router.post("/wallet/charge", userRoute(async (req, _res, _user) => {
    z.object({ amount: z.number().positive(), method: z.enum(["qpay", "card"]) }).parse(req.body);
    apiError(501, "Wallet charge requires a verified payment-provider integration");
  }));

  router.get("/moderation/penalties", userRoute(async (req, res) => {
    const filters = z.object({ type: penaltyTypeSchema.optional(), query: z.string().trim().min(1).max(64).optional() }).parse(req.query);
    let query = db().from("penalties").select("*,users!penalties_user_id_fkey(username,steam_id,avatar)").order("created_at", { ascending: false });
    if (filters.type) query = query.eq("type", filters.type);
    const { data, error } = await query;
    legacyXError(error, "Unable to load penalties");
    const penalties = await mapPenaltiesWithProfileIdentities((data ?? []) as DbRow[], db());
    res.json(filters.query ? penalties.filter(penalty => penalty.player.toLowerCase().includes(filters.query!.toLowerCase())) : penalties);
  }));
  router.get("/moderation/penalties/stats", userRoute(async (_req, res) => {
    const { data, error } = await db().from("penalties").select("type,is_permanent,is_unbanned");
    legacyXError(error, "Unable to load penalty statistics");
    const penalties = (data ?? []) as DbRow[];
    res.json({ totalBans: penalties.filter(row => row.type === "ban").length, activeBans: penalties.filter(row => row.type === "ban" && !row.is_unbanned).length, permanentBans: penalties.filter(row => row.type === "ban" && row.is_permanent).length, totalComms: penalties.filter(row => row.type === "comm").length, totalGags: penalties.filter(row => row.type === "gag").length });
  }));
  router.get("/penalties/:penaltyId", userRoute(async (req, res) => {
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

  router.get("/search/players", userRoute(async (req, res) => {
    const input = z.object({ query: z.string().trim().min(1).max(64) }).parse(req.query);
    const { data, error } = await db().from("users").select("id,steam_id,username,avatar,level,player_stats(*)").ilike("username", `%${input.query}%`).order("username");
    legacyXError(error, "Unable to search players");
    res.json({ players: ((data ?? []) as DbRow[]).map(mapLeaderFromUser) });
  }));
  router.get("/search/clans", userRoute(async (req, res) => {
    const input = z.object({ query: z.string().trim().min(1).max(64) }).parse(req.query);
    const { data, error } = await db().from("clans").select("*,clan_members(count)").ilike("name", `%${input.query}%`).order("name");
    legacyXError(error, "Unable to search clans");
    res.json({ clans: ((data ?? []) as DbRow[]).map(mapClanCard) });
  }));
  router.get("/community/content", userRoute(async (_req, res) => {
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
  router.post("/auth/logout", asyncRoute(async (req, res) => {
    await revokeRefreshSession(refreshTokenFromRequest(req));
    res.clearCookie("legacyx_access_token", sessionCookieOptions(0));
    res.clearCookie("legacyx_refresh_token", sessionCookieOptions(0));
    res.status(204).end();
  }));
  router.post("/auth/refresh", asyncRoute(async (req, res) => {
    const user = await rotateRefreshSession(refreshTokenFromRequest(req));
    const [accessToken, refreshToken] = await Promise.all([issueAccessToken(user), createRefreshSession(user.id)]);
    res.cookie("legacyx_access_token", accessToken, sessionCookieOptions(15 * 60 * 1000));
    res.cookie("legacyx_refresh_token", refreshToken, sessionCookieOptions(30 * 24 * 60 * 60 * 1000));
    res.json({ accessToken, refreshToken });
  }));
  router.get("/auth/me", userRoute(async (_req, res, user) => {
    res.json({ user: await getUserWithStats(user.id) });
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
    const [users, products, transactions, matches, actions] = await Promise.all([
      db().from("users").select("id", { count: "exact", head: true }),
      db().from("store_items").select("id", { count: "exact", head: true }),
      db().from("wallet_transactions").select("id", { count: "exact", head: true }),
      db().from("matches").select("id", { count: "exact", head: true }),
      db().from("staff_panel_actions").select("id", { count: "exact", head: true }),
    ]);
    legacyXError(users.error || products.error || transactions.error || matches.error || actions.error, "Unable to load database overview");
    res.json({ tables: [
      { name: "users", count: users.count ?? 0 }, { name: "store_items", count: products.count ?? 0 },
      { name: "wallet_transactions", count: transactions.count ?? 0 }, { name: "matches", count: matches.count ?? 0 },
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

  router.get("/staffpanel/products", ownerPanelRoute(async (_req, res) => {
    const { data, error } = await db().from("store_items").select("*").order("created_at", { ascending: false });
    legacyXError(error, "Unable to load products");
    res.json(((data ?? []) as DbRow[]).map((item) => ({ ...mapShopItem(item), active: Boolean(item.is_active) })));
  }));
  router.post("/staffpanel/products", ownerPanelRoute(async (req, res) => {
    const input = staffPanelProductSchema.parse(req.body);
    const { data, error } = await db().from("store_items").insert({ ...input, is_active: true }).select("*").single();
    legacyXError(error, "Unable to create product");
    res.status(201).json({ ...mapShopItem(data as DbRow), active: true });
  }));
  router.patch("/staffpanel/products/:itemId", ownerPanelRoute(async (req, res) => {
    const input = staffPanelProductSchema.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    const { active, ...product } = input;
    const { data, error } = await db().from("store_items").update({ ...product, ...(active === undefined ? {} : { is_active: active }) }).eq("id", userIdSchema.parse(req.params.itemId)).select("*").single();
    legacyXError(error, "Unable to update product");
    res.json({ ...mapShopItem(data as DbRow), active: Boolean((data as DbRow).is_active) });
  }));
  router.delete("/staffpanel/products/:itemId", ownerPanelRoute(async (req, res) => {
    const { error } = await db().from("store_items").update({ is_active: false }).eq("id", userIdSchema.parse(req.params.itemId));
    legacyXError(error, "Unable to archive product");
    res.status(204).end();
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

  const leaderboardHandler = asyncRoute(async (req, res) => {
    const { sort, limit, offset } = leaderboardSchema.parse(req.query);
    const { data, error, count } = await db().from("player_stats").select("*,users(id,steam_id,username,avatar,level,rank)", { count: "exact" }).order(sort, { ascending: false }).range(offset, offset + limit - 1);
    legacyXError(error, "Unable to load leaderboard");
    sendPage(res, data, count, limit, offset);
  });
  router.get("/leaderboard", leaderboardHandler);
  router.get("/players/leaderboard", leaderboardHandler);
  router.get("/players/:playerId", asyncRoute(async (req, res) => {
    res.json({ player: await getUserWithStats(req.params.playerId) });
  }));

  router.get("/profile/:userId", asyncRoute(async (req, res) => {
    const [user, linksResult] = await Promise.all([
      getUserWithStats(req.params.userId),
      db().from("user_links").select("id,url,created_at").eq("user_id", req.params.userId).order("created_at"),
    ]);
    legacyXError(linksResult.error, "Unable to load profile links");
    res.json({ profile: user, links: linksResult.data ?? [] });
  }));
  router.put("/profile/me", userRoute(async (req, res, user) => {
    const updates = profileUpdateSchema.parse(req.body);
    const { data, error } = await db().from("users").update(updates).eq("id", user.id).select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level").single();
    legacyXError(error, "Unable to update profile");
    res.json({ profile: data });
  }));
  router.get("/competitive/me/access", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("competitive_player_profiles").select("current_exp,rank_id,rank_name,rank_image_key,pro_league_unlocked").eq("user_id", user.id).maybeSingle();
    legacyXError(error, "Unable to load competitive access");
    res.json({
      competitive: data ?? null,
      proLeagueUnlocked: Boolean(data?.pro_league_unlocked),
      requiredRankId: 11,
      requiredRankName: "Master Guardian I",
    });
  }));
  router.get("/profile/:userId/stats", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("player_stats").select("*").eq("user_id", req.params.userId).maybeSingle();
    legacyXError(error, "Unable to load player stats");
    if (!data) apiError(404, "Player stats were not found");
    res.json({ stats: data });
  }));
  router.get("/profile/:userId/matches", asyncRoute(async (req, res) => {
    const { limit, offset } = pageSchema.parse(req.query);
    const { data, error, count } = await db().from("player_match_history").select("*", { count: "exact" }).eq("user_id", req.params.userId).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    legacyXError(error, "Unable to load match history");
    sendPage(res, data, count, limit, offset);
  }));
  router.get("/profile/:userId/penalties", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("penalties").select("*").eq("user_id", req.params.userId).order("created_at", { ascending: false });
    legacyXError(error, "Unable to load penalties");
    res.json({ penalties: data ?? [] });
  }));
  router.put("/profile/me/links", userRoute(async (req, res, user) => {
    const { links } = linksSchema.parse(req.body);
    const { error } = await db().rpc("replace_user_links", { p_user_id: user.id, p_links: links });
    legacyXError(error, "Unable to replace profile links");
    res.json({ links });
  }));

  router.get("/servers", asyncRoute(async (req, res) => {
    let query = db().from("game_servers").select("*").order("name");
    if (typeof req.query.status === "string") query = query.eq("status", req.query.status);
    if (typeof req.query.mode === "string") query = query.eq("mode", req.query.mode);
    const { data, error } = await query;
    legacyXError(error, "Unable to load servers");
    res.json({ servers: data ?? [] });
  }));
  router.get("/servers/stats", asyncRoute(async (_req, res) => {
    const [servers, matches, clans] = await Promise.all([
      db().from("game_servers").select("id,current_players,status", { count: "exact" }),
      db().from("matches").select("id", { count: "exact" }).eq("status", "live"),
      db().from("clans").select("id", { count: "exact" }),
    ]);
    legacyXError(servers.error || matches.error || clans.error, "Unable to load server statistics");
    res.json({ servers: servers.count ?? 0, onlinePlayers: (servers.data ?? []).reduce((total, server) => total + server.current_players, 0), liveMatches: matches.count ?? 0, clans: clans.count ?? 0 });
  }));
  router.get("/servers/:serverId", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("game_servers").select("*").eq("id", req.params.serverId).maybeSingle();
    legacyXError(error, "Unable to load server");
    if (!data) apiError(404, "Server was not found");
    res.json({ server: data });
  }));
  router.post("/servers/:serverId/join", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("game_servers").select("id,name,ip_address,port,status").eq("id", req.params.serverId).maybeSingle();
    legacyXError(error, "Unable to load server connection");
    if (!data) apiError(404, "Server was not found");
    if (!data.ip_address || !data.port || data.status === "offline") apiError(409, "Server is not currently joinable");
    res.json({ serverId: data.id, name: data.name, connect: `${data.ip_address}:${data.port}` });
  }));

  router.get("/matches", asyncRoute(async (req, res) => {
    const { limit, offset } = pageSchema.parse(req.query);
    let query = db().from("matches").select("*,game_servers(id,name,ip_address,port),maps(id,label)", { count: "exact" }).order("number").range(offset, offset + limit - 1);
    if (typeof req.query.mode === "string") query = query.eq("mode", req.query.mode);
    if (typeof req.query.status === "string") query = query.eq("status", req.query.status);
    const { data, error, count } = await query;
    legacyXError(error, "Unable to load matches");
    sendPage(res, data, count, limit, offset);
  }));
  router.get("/matches/:matchId", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("matches").select("*,game_servers(id,name,ip_address,port),maps(id,label)").eq("id", req.params.matchId).maybeSingle();
    legacyXError(error, "Unable to load match");
    if (!data) apiError(404, "Match was not found");
    res.json({ match: data });
  }));
  router.post("/matches/:matchId/join", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("matches").select("id,status,game_servers(ip_address,port)").eq("id", req.params.matchId).maybeSingle();
    legacyXError(error, "Unable to resolve match server");
    if (!data) apiError(404, "Match was not found");
    res.json({ matchId: data.id, status: data.status, server: data.game_servers });
  }));
  router.post("/matches/:matchId/favorite", userRoute(async (req, res, user) => {
    const { data: existing, error } = await db().from("match_favorites").select("id").eq("user_id", user.id).eq("match_id", req.params.matchId).maybeSingle();
    legacyXError(error, "Unable to read match favorite");
    if (existing) {
      const { error: deleteError } = await db().from("match_favorites").delete().eq("id", existing.id);
      legacyXError(deleteError, "Unable to remove match favorite");
      res.json({ favorited: false });
      return;
    }
    const { error: insertError } = await db().from("match_favorites").insert({ user_id: user.id, match_id: req.params.matchId });
    legacyXError(insertError, "Unable to favorite match");
    res.json({ favorited: true });
  }));

  router.get("/clans", asyncRoute(async (req, res) => {
    const { limit, offset } = pageSchema.parse(req.query);
    let query = db().from("clans").select("*,clan_members(count)", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    if (typeof req.query.query === "string" && req.query.query.trim()) query = query.ilike("name", `%${req.query.query.trim()}%`);
    const { data, error, count } = await query;
    legacyXError(error, "Unable to load clans");
    sendPage(res, data, count, limit, offset);
  }));
  router.get("/clans/me", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("clan_members").select("role,clans(*)").eq("user_id", user.id).maybeSingle();
    legacyXError(error, "Unable to load current clan");
    res.json({ membership: data ?? null });
  }));
  router.post("/clans", userRoute(async (req, res, user) => {
    const input = clanSchema.parse(req.body);
    const { data, error } = await db().rpc("create_clan_with_leader", { p_owner_id: user.id, p_name: input.name, p_tag: input.tag, p_logo: input.logo ?? "", p_thumbnail: input.thumbnail ?? null, p_description: input.description ?? null, p_region: input.region ?? "Mongolia", p_max_players: input.maxPlayers ?? 10 });
    legacyXError(error, "Unable to create clan");
    res.status(201).json({ clanId: data });
  }));
  router.get("/clans/:clanId", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("clans").select("*,users!clans_owner_id_fkey(id,username,avatar),clan_members(count)").eq("id", req.params.clanId).maybeSingle();
    legacyXError(error, "Unable to load clan");
    if (!data) apiError(404, "Clan was not found");
    res.json({ clan: data });
  }));
  router.get("/clans/:clanId/members", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("clan_members").select("id,role,created_at,users(id,username,avatar,level,rank)").eq("clan_id", req.params.clanId).order("created_at");
    legacyXError(error, "Unable to load clan members");
    res.json({ members: data ?? [] });
  }));
  router.post("/clans/:clanId/join", userRoute(async (req, res, user) => {
    const { error } = await db().rpc("join_clan", { p_user_id: user.id, p_clan_id: req.params.clanId });
    legacyXError(error, "Unable to join clan");
    res.status(204).end();
  }));
  router.post("/clans/:clanId/leave", userRoute(async (req, res, user) => {
    const { data: clan, error: clanError } = await db().from("clans").select("owner_id").eq("id", req.params.clanId).maybeSingle();
    legacyXError(clanError, "Unable to load clan");
    if (!clan) apiError(404, "Clan was not found");
    if (clan.owner_id === user.id) apiError(409, "Clan owner must delete the clan or transfer ownership before leaving");
    const { error } = await db().from("clan_members").delete().eq("clan_id", req.params.clanId).eq("user_id", user.id);
    legacyXError(error, "Unable to leave clan");
    res.status(204).end();
  }));
  router.delete("/clans/:clanId", userRoute(async (req, res, user) => {
    const { error } = await db().rpc("delete_owned_clan", { p_owner_id: user.id, p_clan_id: req.params.clanId });
    legacyXError(error, "Unable to delete clan");
    res.status(204).end();
  }));

  router.get("/tournaments/info", asyncRoute(async (_req, res) => {
    const { data: tournament, error } = await db().from("tournaments").select("*").in("status", ["active", "upcoming"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    legacyXError(error, "Unable to load tournament");
    if (!tournament) {
      res.json({ tournament: null, registeredClans: 0 });
      return;
    }
    const { count, error: countError } = await db().from("tournament_registrations").select("id", { count: "exact", head: true }).eq("tournament_id", tournament.id);
    legacyXError(countError, "Unable to count tournament registrations");
    res.json({ tournament, registeredClans: count ?? 0 });
  }));
  router.get("/tournaments/matches", asyncRoute(async (req, res) => {
    let query = db().from("tournament_matches").select("*,tournaments(id,season),maps(id,label)").order("bracket_order");
    if (typeof req.query.tournamentId === "string") query = query.eq("tournament_id", req.query.tournamentId);
    const { data, error } = await query;
    legacyXError(error, "Unable to load tournament matches");
    res.json({ matches: data ?? [] });
  }));
  router.get("/tournaments/matches/:matchId", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("tournament_matches").select("*,tournaments(id,season),maps(id,label)").eq("id", req.params.matchId).maybeSingle();
    legacyXError(error, "Unable to load tournament match");
    if (!data) apiError(404, "Tournament match was not found");
    res.json({ match: data });
  }));
  router.get("/tournaments/bracket", asyncRoute(async (req, res) => {
    let query = db().from("tournament_matches").select("*").order("bracket_order");
    if (typeof req.query.tournamentId === "string") query = query.eq("tournament_id", req.query.tournamentId);
    const { data, error } = await query;
    legacyXError(error, "Unable to load tournament bracket");
    res.json({ bracket: data ?? [] });
  }));
  router.post("/tournaments/register", userRoute(async (req, res, user) => {
    const input = z.object({ tournamentId: z.string().uuid(), clanId: z.string().uuid() }).parse(req.body);
    const { data: clan, error: clanError } = await db().from("clans").select("id").eq("id", input.clanId).eq("owner_id", user.id).maybeSingle();
    legacyXError(clanError, "Unable to validate clan ownership");
    if (!clan) apiError(403, "Only the clan owner can register a clan");
    const { error } = await db().from("tournament_registrations").insert({ tournament_id: input.tournamentId, clan_id: input.clanId });
    legacyXError(error, "Unable to register clan for tournament");
    res.status(201).end();
  }));

  router.get("/store/items", asyncRoute(async (req, res) => {
    let query = db().from("store_items").select("*").order("created_at", { ascending: false });
    if (typeof req.query.category === "string") query = query.eq("category", req.query.category);
    if (typeof req.query.rarity === "string") query = query.eq("rarity", req.query.rarity);
    const { data, error } = await query;
    legacyXError(error, "Unable to load store items");
    res.json({ items: data ?? [] });
  }));
  router.get("/store/items/:itemId", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("store_items").select("*").eq("id", req.params.itemId).maybeSingle();
    legacyXError(error, "Unable to load store item");
    if (!data) apiError(404, "Store item was not found");
    res.json({ item: data });
  }));
  router.post("/store/items/:itemId/purchase", userRoute(async (req, res, user) => {
    const { data, error } = await db().rpc("purchase_store_item", { p_user_id: user.id, p_item_id: req.params.itemId });
    legacyXError(error, "Unable to complete purchase");
    res.status(201).json({ purchase: data });
  }));
  router.get("/wallet", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("users").select("balance").eq("id", user.id).single();
    legacyXError(error, "Unable to load wallet");
    if (!data) apiError(404, "Wallet owner was not found");
    res.json({ balance: data.balance, currency: "coins" });
  }));
  router.get("/wallet/transactions", userRoute(async (req, res, user) => {
    const { limit, offset } = pageSchema.parse(req.query);
    const { data, error, count } = await db().from("wallet_transactions").select("*", { count: "exact" }).eq("user_id", user.id).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    legacyXError(error, "Unable to load wallet transactions");
    sendPage(res, data, count, limit, offset);
  }));
  router.post("/wallet/charge", staffRoute(async (req, res, _user) => {
    const input = z.object({ userId: z.string().uuid(), amount: z.number().int().positive(), method: z.string().trim().min(1).max(64) }).parse(req.body);
    const { data, error } = await db().rpc("credit_wallet", { p_user_id: input.userId, p_amount: input.amount, p_method: input.method });
    legacyXError(error, "Unable to credit wallet");
    res.status(201).json({ transaction: data });
  }));

  router.get("/penalties", asyncRoute(async (req, res) => {
    const { limit, offset } = pageSchema.parse(req.query);
    let query = db().from("penalties").select("*,users!penalties_user_id_fkey(id,username,avatar)", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    if (typeof req.query.type === "string") query = query.eq("type", req.query.type);
    const { data, error, count } = await query;
    legacyXError(error, "Unable to load penalties");
    sendPage(res, data, count, limit, offset);
  }));
  router.get("/penalties/stats", asyncRoute(async (_req, res) => {
    const { data, error } = await db().from("penalties").select("type,is_permanent,is_unbanned");
    legacyXError(error, "Unable to load penalty statistics");
    const penalties = data ?? [];
    res.json({ total: penalties.length, active: penalties.filter(p => !p.is_unbanned).length, permanent: penalties.filter(p => p.is_permanent).length, byType: penalties.reduce<Record<string, number>>((result, penalty) => ({ ...result, [penalty.type]: (result[penalty.type] ?? 0) + 1 }), {}) });
  }));
  router.get("/penalties/:penaltyId", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("penalties").select("*,users!penalties_user_id_fkey(id,username,avatar)").eq("id", req.params.penaltyId).maybeSingle();
    legacyXError(error, "Unable to load penalty");
    if (!data) apiError(404, "Penalty was not found");
    res.json({ penalty: data });
  }));

  router.get("/search/players", asyncRoute(async (req, res) => {
    const input = z.object({ q: z.string().trim().min(1).max(64), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const { data, error } = await db().from("users").select("id,steam_id,username,avatar,level,rank").ilike("username", `%${input.q}%`).limit(input.limit);
    legacyXError(error, "Unable to search players");
    res.json({ players: data ?? [] });
  }));
  router.get("/search/clans", asyncRoute(async (req, res) => {
    const input = z.object({ q: z.string().trim().min(1).max(64), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const { data, error } = await db().from("clans").select("id,name,tag,logo,region").ilike("name", `%${input.q}%`).limit(input.limit);
    legacyXError(error, "Unable to search clans");
    res.json({ clans: data ?? [] });
  }));

  router.get("/community/content", asyncRoute(async (_req, res) => {
    const [creators, partners] = await Promise.all([db().from("community_creators").select("*").order("created_at"), db().from("community_partners").select("*").order("created_at")]);
    legacyXError(creators.error || partners.error, "Unable to load community content");
    res.json({ creators: creators.data ?? [], partners: partners.data ?? [] });
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
  router.post("/plugin/matches", pluginRoute("matches:write", async (req, res, plugin) => {
    const input = pluginMatchSchema.parse(req.body);
    const { data, error } = await db().from("matches").insert(input).select("*").single();
    legacyXError(error, "Unable to create match");
    await writePluginAudit(plugin, "match.create", "matches", data.id, { mode: data.mode, number: data.number });
    res.status(201).json({ match: data });
  }));
  router.patch("/plugin/matches/:matchId", pluginRoute("matches:write", async (req, res, plugin) => {
    const input = pluginMatchSchema.partial().omit({ id: true }).parse(req.body);
    const { data, error } = await db().from("matches").update(input).eq("id", req.params.matchId).select("*").single();
    legacyXError(error, "Unable to update match");
    await writePluginAudit(plugin, "match.update", "matches", data.id, { status: data.status, scoreT: data.score_t, scoreCt: data.score_ct });
    res.json({ match: data });
  }));
  router.post("/plugin/player-match-history", pluginRoute("stats:write", async (req, res, plugin) => {
    const input = pluginHistorySchema.parse(req.body);
    const { data, error } = await db().rpc("ingest_player_match_result", {
      p_plugin_id: plugin.id,
      p_user_id: input.user_id,
      p_match_id: input.match_id ?? null,
      p_map: input.map,
      p_result: input.result,
      p_score: input.score,
      p_kd: input.kd,
      p_stats: input.stats ?? null,
    });
    legacyXError(error, "Unable to ingest player match result");
    res.status(201).json({ historyId: data });
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
      const result = await db().schema("legacy_x").rpc("ingest_competitive_match_result", { p_plugin_id: pluginId, p_event_id: input.event_id, p_payload: input });
      legacyXError(result.error, "Unable to ingest competitive match result");
      competitive = result.data ?? null;
    }
    res.status(200).json({ result: data ?? {}, competitive });
  }));
  router.post("/plugin/matchzy/events", pluginRoute("stats:write", async (req, res, plugin) => {
    const input = z.object({ event_id: pluginEventIdSchema, event: z.string().min(1).max(64) }).passthrough().parse(req.body);
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
  router.get("/plugin/community/players/:steamId", pluginRoute("stats:write", async (req, res) => {
    const steamId = String(req.params.steamId || "").trim();
    if (!/^\d{15,20}$/.test(steamId)) apiError(400, "steamId must be a 15-20 digit SteamID64");
    const { data, error } = await db().from("community_player_profiles").select("steam_id,username,avatar,level,experience,rating,rank_tier,clan_id,clan_name,clan_tag,clan_role").eq("steam_id", steamId).maybeSingle();
    legacyXError(error, "Unable to load plugin community player profile");
    if (!data) apiError(404, "Player profile not found");
    res.json({ profile: data });
  }));

  router.post("/plugin/skinchanger/sessions", pluginRoute("skinchanger:write", async (req, res, plugin) => {
    const input = skinchangerPluginSessionSchema.parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-skinbridge") apiError(403, "LegacyX SkinBridge plugin identity is required");
    const { data, error } = await db().rpc("ingest_skinchanger_session", {
      p_event_id: input.eventId,
      p_plugin_id: pluginId,
      p_event_type: input.event,
      p_server_id: input.serverId,
      p_steam_id: input.steamId,
      p_player_name: input.playerName,
    });
    legacyXError(error, "Unable to ingest skinchanger session");
    await writePluginAudit(plugin, `skinchanger.${input.event}`, "skinchanger_server_sessions", input.steamId, { serverId: input.serverId, eventId: input.eventId });
    res.status(200).json({ result: data ?? {} });
  }));

  router.get("/plugin/skinchanger/jobs", pluginRoute("skinchanger:read", async (req, res, plugin) => {
    const serverId = z.string().trim().min(1).max(120).parse(req.query.server_id);
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query.limit);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-skinbridge") apiError(403, "LegacyX SkinBridge plugin identity is required");
    const { data, error } = await db().rpc("claim_skinchanger_apply_jobs", { p_server_id: serverId, p_limit: limit });
    legacyXError(error, "Unable to claim skinchanger apply jobs");
    await writePluginAudit(plugin, "skinchanger.jobs.claim", "skinchanger_apply_jobs", null, { serverId, count: (data ?? []).length });
    res.json({ jobs: data ?? [] });
  }));

  router.post("/plugin/skinchanger/jobs/:jobId/ack", pluginRoute("skinchanger:write", async (req, res, plugin) => {
    const input = skinchangerPluginAckSchema.parse(req.body);
    const jobId = z.string().uuid().parse(req.params.jobId);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-skinbridge") apiError(403, "LegacyX SkinBridge plugin identity is required");
    const { data, error } = await db().rpc("ack_skinchanger_apply", {
      p_job_id: jobId,
      p_lease_token: input.leaseToken,
      p_status: input.status,
      p_failure_code: input.failureCode ?? null,
      p_failure_detail: input.failureDetail ?? null,
    });
    legacyXError(error, "Unable to acknowledge skinchanger apply job");
    await writePluginAudit(plugin, `skinchanger.job.${input.status}`, "skinchanger_apply_jobs", jobId, { failureCode: input.failureCode ?? null });
    res.status(200).json({ result: data ?? {} });
  }));
  router.post("/plugin/live-match/snapshots", pluginRoute("servers:write", async (req, res, plugin) => {
    const input = z.object({ event_id: pluginEventIdSchema, server_id: z.string().trim().min(1).max(120), live_match: liveMatchSnapshotV1Schema }).strict().parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (!new Set(["legacyx-reconnect", "legacyx-live-snapshot"]).has(pluginId)) apiError(403, "Live snapshot plugin identity is required");
    const result = await ingestLiveMatchSnapshot(pluginId, input.event_id, input.server_id, input.live_match);
    await writePluginAudit(plugin, "live_match.snapshot", "server_live_match_snapshots", input.server_id, { eventId: input.event_id, snapshotRevision: input.live_match.snapshot_revision });
    res.status(200).json({ result });
  }));
  router.post("/plugin/reconnect/events", pluginRoute("servers:write", async (req, res, plugin) => {
    const input = z.object({ event: z.enum(["player_connected", "player_disconnected", "server_heartbeat"]), event_id: pluginEventIdSchema, server_id: z.string().min(1).max(120), server_address: z.string().min(1).max(255), map_name: z.string().max(128).optional().default(""), mode: z.string().max(128).optional().default(""), player_count: z.coerce.number().int().min(0).max(128).optional(), live_match: liveMatchSnapshotV1Schema.optional(), session_id: z.string().uuid().optional(), steam_id: z.string().regex(/^\d{15,20}$/).optional(), player_name: z.string().max(128).optional().default(""), disconnect_reason: z.string().max(96).optional().default(""), reconnect_window_minutes: z.coerce.number().int().min(5).max(1440).optional().default(720) }).strict().parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-reconnect") apiError(403, "Reconnect plugin identity is required");
    if (input.event === "server_heartbeat") {
      const { data, error } = await db().schema("legacy_x").rpc("ingest_reconnect_heartbeat", { p_event_id: input.event_id, p_plugin_id: pluginId, p_server_id: input.server_id, p_server_address: input.server_address, p_map_name: input.map_name, p_mode: input.mode, p_player_count: input.player_count ?? 0 });
      legacyXError(error, "Unable to ingest reconnect server heartbeat");
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
