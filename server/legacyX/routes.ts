import express, { Router, type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authorizeUrl, consumeOAuthState, createOAuthState, discordOAuthConfig, fetchDiscordIdentity, isOAuthState, linkDiscordAccount, ownDiscordLink, removeOwnDiscordLink } from "./discordOAuth";
import { isReaction, tallyReactions } from "./reactions";
import { mayApproveLifts, mayModerate, mayModerateClans, mayTouchBan, needsLiftApproval, needsReview, termFields, type ModerationCapability } from "./moderation";
import { CLAN_LIMITS, canManage, canRemove, clanRole, describeClanAction, leaveCooldownLeftMs } from "./clans";
import { CLAN_ART_LIMITS, artMarker, artUrl, checkClanArt, type ClanArtKind } from "./clanArt";
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
import { apiAuthRateLimitMax, apiRateLimitMax, apiSensitiveRateLimitMax, apiSessionRateLimitMax, isDeferredFeatureEnabled, publicDeferredFeatureFlags, type DeferredFeatureKey } from "./config";
import { getFaceitProfileSnapshot, getFaceitProfileSnapshotForSteamId, resolveFaceitNickname } from "./faceit";
import { legacyXDb, legacyXError } from "./supabase";
import { resolveSteamProfileMedia } from "./steamBackground";
import { coreRoundScore, expRowAsResult, mapExpRecentMatch, mapMatchDetail } from "./matchDetails";
import { fetchSteamAccountCreatedAt, fetchSteamBans, syncSteamUserProfile } from "./steamProfile";
import { RANK_CALCULATION_VERSION, calculateMatchExp, expLimitUsage, limitWindows } from "./ranking";
import { buildRankedInput, rankedResultSchema, type MatchParticipant, type PlayerProgression } from "./rankedMatch";
import { ANNOUNCEMENT_MAX_AGE_HOURS, ANNOUNCEMENT_PAGE, announcementRow, announcementSchema, announcementView, type AnnouncementRecord } from "./announcements";
import { ADMIN_CALL_COOLDOWN_SECONDS, ADMIN_CALL_MAX_AGE_HOURS, ADMIN_CALL_PAGE, adminCallRow, adminCallSchema, adminCallView, parseAfter, type AdminCallRecord } from "./adminCalls";
import { COIN_RULES, NotEnoughCoinsError, applyWalletChange, awardDiscordLink, awardMatchBonuses, awardMatchCoins, clanPrices, earnRules, loadWallet, loadWalletSummary, penalizeWallet, walletGrantSchema, walletPenaltySchema } from "./wallet";
import { isMissingTableError, ownerLinks, ownerProfileSchema, ownerTeam, ownerUpdates } from "./ownerProfile";
import { PROFILE_NAME_MAX, PROFILE_SECTIONS, bestNameMatch, escapeLike, hiddenForViewer, loadoutShowcase, mapWinRates, normalizeHiddenSections, profileStats, staffCard, type ProfileSection } from "./profileOverview";
import { activeBans, bannedPlayer, checkBansSchema, issueBan, issueBanSchema, revokeAllBans, revokeAllBansSchema, revokeBans, revokeBanSchema } from "./bans";
import { authorizationRequestSchema, resolveAuthorizations } from "./adminAuthorization";
import { completeLink, createLinkRequest, discordLinkedUserIds, discordIdSchema, isLinkToken, linkCallbackUrl, linkRequestSchema, linkStartUrl, linkResultPage, listLinks, pendingLinkRequest, returnToMatches, unlink } from "./discordLinks";
import { issueCommPenalty, issueCommPenaltySchema, liftCommPenalties, liftCommPenaltySchema } from "./gamePenalties";
import { checkerBase, zipChunks, zipLength } from "./checkerZip";
import { CHECK_CODE_MINUTES, CHECK_MAX_DOWNLOADS, CHECK_RETENTION_DAYS, CHECK_ROLES, checkReportSchema, createCheckSchema, generateCheckCode, hashCheckCode, normalizeCheckCode, summarizeReport } from "./playerChecks";
import { CLAN_LOOK_ITEMS, CLAN_LOOK_KINDS, clanLookItem, clanLooksFor } from "./clanLooks";
import { killEventSchema, killFeed } from "./killfeed";
import { heartbeatSchema, ingestHeartbeat } from "./serverHeartbeat";
import { mapPlayServer, pickQuickJoin, sortPlayServers, type PlayMode } from "./play";
import { bracketRounds, checkInOpen, groupTeams, mapTournamentMatch as mapTournamentPlayerMatch, mapTournamentSummary, nextMatchFor, tournamentPhase } from "./tournaments";

type ApiRequest = Request & { legacyUser?: LegacyUser; plugin?: PluginPrincipal };
type AsyncHandler = (req: ApiRequest, res: Response, next: NextFunction) => Promise<void>;

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
const leaderboardSchema = pageSchema.extend({ sort: z.enum(["rating", "kd_ratio", "experience"]).default("rating") });

function apiError(statusCode: number, message: string, code?: string): never {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = statusCode;
  if (code) error.code = code;
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

function hasAccessToken(req: Request) {
  return Boolean(req.header("authorization")?.startsWith("Bearer ") || parseCookieHeader(req.headers.cookie ?? "").legacyx_access_token);
}

/** Public read routes: guests are served as null, while a present-but-invalid token still 401s so the client can refresh it. */
function optionalUserRoute(handler: (req: ApiRequest, res: Response, user: LegacyUser | null) => Promise<void>) {
  return asyncRoute(async (req, res) => handler(req, res, hasAccessToken(req) ? await requireUser(req) : null));
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function writePluginAudit(plugin: PluginPrincipal, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown>) {
  // audit_logs.target_id is a uuid; server ids (srv-27015), SteamIDs and other keys go in metadata instead.
  const uuidTarget = targetId !== null && UUID_PATTERN.test(targetId) ? targetId : null;
  const { error } = await legacyXDb().from("audit_logs").insert({
    actor_type: "plugin",
    actor_id: plugin.id,
    action,
    target_type: targetType,
    target_id: uuidTarget,
    metadata: targetId !== null && uuidTarget === null ? { ...metadata, targetKey: targetId } : metadata,
  });
  legacyXError(error, "Unable to record plugin audit entry");
}

/** Profile boxes a player may hide from others. Penalty history, SteamID, Steam link and rank always stay public. */
const PROFILE_HIDEABLE_SECTIONS = PROFILE_SECTIONS;
type ProfileHideableSection = ProfileSection;
// Names and avatars come only from Steam (syncSteamUserProfile). Accepting a client-supplied avatar URL
// let anyone show arbitrary images and let third parties log every profile viewer's IP.
const profileUpdateSchema = z.object({
  hiddenSections: z.array(z.enum(PROFILE_HIDEABLE_SECTIONS)).max(PROFILE_HIDEABLE_SECTIONS.length).optional(),
});
function hiddenSectionsValue(value: unknown): ProfileHideableSection[] {
  return normalizeHiddenSections(value);
}
/** Postgres "undefined column": the privacy migration has not been applied yet. */
function isMissingColumnError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "42703");
}
const STAFF_PROFILE_ROLES: Record<string, string> = { OWNER: "Owner", MANAGER: "Manager", ADMIN: "Admin", DEVELOPER: "Developer", DESIGNER: "Designer" };
const faceitLinkSchema = z.object({ nickname: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "FACEIT nickname contains unsupported characters") });
const linksSchema = z.object({ links: z.array(z.string().url().max(2048)).max(20) });
const clanSchema = z.object({ name: z.string().trim().min(3).max(24), tag: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,5}$/, "Tag is 2-5 letters or numbers"), region: z.string().trim().min(2).max(64).optional(), joinMode: z.enum(["open", "request"]).default("open"), maxPlayers: z.number().int().min(2).max(50).default(10) }).strict();
const feedbackSchema = z.object({ name: z.string().trim().min(1).max(64).optional(), rating: z.number().int().min(1).max(5), message: z.string().trim().min(1).max(4000) });
const pluginServerSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), map: z.string().trim().min(1).max(64), mode: z.string().trim().min(1).max(64), max_players: z.number().int().min(0).max(256), current_players: z.number().int().min(0).max(256), ping: z.number().int().min(0).max(10000).default(0), status: z.enum(["online", "offline", "full"]), ip_address: z.string().max(255).optional(), port: z.number().int().min(1).max(65535).optional() });
const pluginEventIdSchema = z.string().trim().min(8).max(220).regex(/^[A-Za-z0-9:_-]+$/, "event_id contains unsupported characters");
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
const playModeSchema = z.enum(["5vs5", "fun", "proleague", "tournaments"]);
const serverStatusSchema = z.enum(["online", "offline", "full"]);
const penaltyTypeSchema = z.enum(["ban", "comm", "gag"]);
const userRoleSchema = z.enum(["Owner", "Founder", "Manager", "Admin", "Player", "Designer", "Developer"]);
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
  };
  if (user.faceit_username && user.faceit_elo != null && user.faceit_level != null) {
    profile.faceit = { username: textValue(user.faceit_username), elo: numberValue(user.faceit_elo), level: numberValue(user.faceit_level) };
  }
  profile.links = links.map(link => ({ url: textValue(link.url) }));
  profile.hiddenSections = hiddenSectionsValue(user.hidden_profile_sections);
  return profile;
}

function mapProfileStats(stats: DbRow) {
  return { matches: numberValue(stats.matches), wins: numberValue(stats.wins), kdRatio: numberValue(stats.kd_ratio), rating: numberValue(stats.rating) };
}

function mapServer(server: DbRow) {
  return { id: textValue(server.id), name: textValue(server.name), map: textValue(server.map), players: numberValue(server.current_players), maxPlayers: numberValue(server.max_players), mode: textValue(server.mode), ping: numberValue(server.ping), status: textValue(server.status) };
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
  return { id: textValue(clan.id), number: numberValue(clan.number), name: textValue(clan.name), tag: textValue(clan.tag), logo: artUrl(textValue(clan.id), "logo", clan.logo) ?? "", thumbnail: artUrl(textValue(clan.id), "banner", clan.thumbnail), currentPlayers, maxPlayers: numberValue(clan.max_players), region: textValue(clan.region), joinMode: clan.join_mode === "request" ? "request" : "open" };
}

function mapClanMember(member: DbRow) {
  const user = firstRow(member.users) ?? {};
  return { id: textValue(user.id || member.user_id), steamId: textValue(user.steam_id), name: textValue(user.username), role: textValue(member.role), avatar: textValue(user.avatar), description: "" };
}

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
  if (path.startsWith("/clans") || path.startsWith("/clan")) return "clan";
  if (path === "/search/clans") return "clan";
  return null;
}

/**
 * Rank a finished Match Core match: load the roster and everyone's EXP at match start, run the
 * rank formula (server/legacyX/ranking.ts), then apply every delta in one SQL transaction. The
 * receipt is keyed by the final event id, so a replayed event is a no-op.
 */
async function applyRankedMatchResult(pluginId: string, eventId: string, matchId: string, rawResult: unknown) {
  const parsed = rankedResultSchema.safeParse(rawResult ?? {});
  if (!parsed.success) return { status: "not_ranked", reasons: ["invalid_result_payload"] };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [matchRow, participantRows] = await Promise.all([
      legacyXDb().from("core_matches").select("id,state,finished_at,final_event_id").eq("id", matchId).maybeSingle(),
      legacyXDb().from("core_match_participants").select("user_id,steam_id,team_key,connected,disconnected_at,returned_at,reconnect_deadline").eq("match_id", matchId),
    ]);
    legacyXError(matchRow.error || participantRows.error, "Unable to load the finished match");
    if (!matchRow.data || matchRow.data.state !== "FINISHED") return { status: "not_ranked", reasons: ["match_not_finished"] };
    const participants = (participantRows.data ?? []) as MatchParticipant[];
    const progressionRows = await legacyXDb().from("competitive_player_progression").select("user_id,current_exp,matches_completed,pro_league_unlocked").in("user_id", participants.map((participant) => participant.user_id));
    legacyXError(progressionRows.error, "Unable to load player EXP");
    const windows = limitWindows();
    const recentGains = await legacyXDb().from("competitive_match_exp").select("user_id,exp_delta,created_at").in("user_id", participants.map((participant) => participant.user_id)).gt("exp_delta", 0).gte("created_at", new Date(windows.weekStart).toISOString());
    legacyXError(recentGains.error, "Unable to load recent EXP gains");
    const gainedToday = new Map<string, number>();
    const gainedThisWeek = new Map<string, number>();
    for (const row of recentGains.data ?? []) {
      gainedThisWeek.set(row.user_id, (gainedThisWeek.get(row.user_id) ?? 0) + Number(row.exp_delta));
      if (new Date(row.created_at).getTime() >= windows.dayStart) gainedToday.set(row.user_id, (gainedToday.get(row.user_id) ?? 0) + Number(row.exp_delta));
    }
    const progression = ((progressionRows.data ?? []) as PlayerProgression[]).map((row) => ({ ...row, exp_gained_today: gainedToday.get(row.user_id) ?? 0, exp_gained_week: gainedThisWeek.get(row.user_id) ?? 0 }));
    const finishedAt = matchRow.data.finished_at ? new Date(matchRow.data.finished_at) : new Date();
    const built = buildRankedInput(parsed.data, participants, progression, finishedAt);
    if (built.unrankable.length > 0) return { status: "not_ranked", reasons: built.unrankable };
    const outcome = calculateMatchExp(built.input);
    if (!outcome.appliesExp) return { status: "not_ranked", reasons: ["fun_mode"] };

    const players = outcome.players.map((player) => {
      const line = built.stats.get(player.userId);
      return {
        user_id: player.userId,
        team_key: player.team,
        outcome: player.outcome,
        exp_before: player.expBefore,
        exp_delta: player.expDelta,
        exp_breakdown: player.breakdown,
        counts_as_ranked: player.countsAsRankedMatch,
        kills: line?.kills ?? 0,
        deaths: line?.deaths ?? 0,
        assists: line?.assists ?? 0,
        headshot_kills: line?.headshot_kills ?? 0,
        stats: { ...(line?.raw ?? {}), rounds_played: line?.rounds_played ?? 0 },
      };
    });
    const summary = {
      valid: outcome.valid,
      invalidReasons: outcome.invalidReasons,
      missingTelemetry: outcome.missingTelemetry,
      totalRounds: outcome.totalRounds,
      teamRating: outcome.teamRating,
      mode: outcome.mode,
    };
    const applied = await legacyXDb().schema("legacy_x").rpc("apply_competitive_match_exp", {
      p_plugin_id: pluginId,
      p_event_id: eventId,
      p_match_id: matchId,
      p_calculation_version: RANK_CALCULATION_VERSION,
      p_summary: summary,
      p_players: players,
    });
    // Someone's EXP moved between reading and applying: recalculate once from fresh values.
    if (applied.error?.code === "40001" && attempt === 0) continue;
    legacyXError(applied.error, "Unable to apply competitive EXP");
    // Coins follow the EXP just applied (and the same limits). A replayed result pays nobody twice (ref = the match).
    const coinLog = (message: string, error: unknown) => console.error(`[legacy-x-api] ${message}`, error);
    await awardMatchCoins(legacyXDb(), matchId, outcome.players, coinLog);
    await awardMatchBonuses(legacyXDb(), matchId, finishedAt, outcome.players, coinLog);
    return { ...recordValue(applied.data), ...summary };
  }
  return { status: "not_ranked", reasons: ["exp_changed_concurrently"] };
}

/** K/D and win-rate rankings only include players with at least this many completed matches. */
const COMPETITIVE_SORT_MIN_MATCHES = 10;

export function createLegacyXRouter() {
  const router = Router();
  const db = () => legacyXDb();
  const mapFeedbackRows = async (rows: DbRow[]) => {
    const userIds = rows.map(row => textValue(row.user_id)).filter((userId, index, values) => Boolean(userId) && values.indexOf(userId) === index);
    if (userIds.length === 0) return rows.map(row => mapFeedback(row));
    const { data, error } = await db().from("users").select("id,steam_id,avatar").in("id", userIds);
    legacyXError(error, "Unable to resolve feedback reviewer profiles");
    const reviewerProfiles = new Map(((data ?? []) as DbRow[]).map(user => [textValue(user.id), { steamId: textValue(user.steam_id), avatar: textValue(user.avatar) }]));
    const worn = await equippedCosmeticsFor(userIds);
    return rows.map(row => ({ ...mapFeedback(row, reviewerProfiles), ...lookOf(worn, textValue(row.user_id)) }));
  };

  router.use(rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : apiRateLimitMax(),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please retry shortly." },
  }));
  // The sign-in endpoints stay strict. The session calls the page makes on every load (me, refresh, logout) have their own roomy limit, so reloading a few times never looks like an attack.
  const SESSION_PATHS = new Set(["/me", "/refresh", "/logout"]);
  const authRateLimit = rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : apiAuthRateLimitMax(),
    skip: (req) => SESSION_PATHS.has(req.path),
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
  const sessionRateLimit = rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : apiSessionRateLimitMax(),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please retry shortly." },
  });
  router.use("/auth", authRateLimit);
  router.use(["/auth/me", "/auth/refresh", "/auth/logout"], sessionRateLimit);
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawIdentity)) {
      // A player's name: /profile/Temuulen opens that profile.
      const name = rawIdentity.trim();
      if (!name || name.length > PROFILE_NAME_MAX) apiError(404, "Player was not found");
      const { data, error } = await db().from("users").select("id,created_at").ilike("username", escapeLike(name)).limit(10);
      legacyXError(error, "Unable to resolve the player name");
      const rows = (data ?? []) as DbRow[];
      if (rows.length === 0) apiError(404, "Player was not found");
      const ladder = rows.length > 1 ? await db().from("competitive_leaderboard").select("user_id,position").in("user_id", rows.map((row) => textValue(row.id))) : { data: [], error: null };
      legacyXError(ladder.error, "Unable to resolve the player name");
      const positions = new Map(((ladder.data ?? []) as DbRow[]).map((row) => [textValue(row.user_id), numberValue(row.position)]));
      return bestNameMatch(rows, positions) ?? apiError(404, "Player was not found");
    }
    return userIdSchema.parse(rawIdentity);
  };
  const profileColumns = "id,steam_id,username,avatar,level,rank,faceit_username,faceit_elo,faceit_level,player_stats(*)";
  const loadProfile = async (id: string) => {
    const [firstUserResult, linksResult] = await Promise.all([
      db().from("users").select(`${profileColumns},hidden_profile_sections`).eq("id", id).maybeSingle(),
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
    if (viewerId) {
      const { data: staff } = await db().from("staff").select("id").eq("user_id", viewerId).eq("status", "active").maybeSingle();
      if (staff) return [] as ProfileHideableSection[];
    }
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
  /** A clan address is its short number (/clans/1) or its long id; both end up as the id. */
  const clanIdOf = async (value: unknown) => {
    const raw = String(value ?? "");
    if (!/^[0-9]{1,9}$/.test(raw)) return userIdSchema.parse(raw);
    const { data, error } = await db().from("clans").select("id").eq("number", Number(raw)).maybeSingle();
    legacyXError(error, "Unable to find the clan");
    if (!data) apiError(404, "Clan was not found");
    return textValue((data as DbRow).id);
  };
  const loadClanDetail = async (clanId: string, viewerId?: string) => {
    const [clanResult, membersResult] = await Promise.all([
      db().from("clans").select("*,clan_members(count)").eq("id", clanId).maybeSingle(),
      db().from("clan_members").select("role,user_id,users(id,steam_id,username,avatar)").eq("clan_id", clanId).order("created_at"),
    ]);
    legacyXError(clanResult.error || membersResult.error, "Unable to load clan");
    if (!clanResult.data) apiError(404, "Clan was not found");
    const clan = clanResult.data as DbRow;
    const worn = await equippedCosmeticsFor(((membersResult.data ?? []) as DbRow[]).map((member) => textValue(member.user_id)));
    const members = ((membersResult.data ?? []) as DbRow[]).map((member) => ({ ...mapClanMember(member), ...lookOf(worn, textValue(member.user_id)) }));
    const viewerRole = viewerId ? members.find((member) => member.id === viewerId)?.role ?? null : null;
    return { ...mapClanCard(clan), look: (await clanLooksFor(db(), [clanId])).get(clanId) ?? null, description: clan.description ?? undefined, members, viewer: { role: viewerRole, canModerate: viewerId ? await canModerateClans(viewerId) : false } };
  };
  // Public website reads deliberately bypass AdminPlus. CS2 plugins/admin tools
  // write to Supabase; the website reads these safe projections through root API.
  const readLimit = (value: unknown) => z.coerce.number().int().min(1).max(100).default(50).parse(value);
  // Leaders shows the whole community, not a top slice, so its ladder is allowed to be long.
  const readLadderLimit = (value: unknown) => z.coerce.number().int().min(1).max(1000).default(500).parse(value);
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
  /** Clan tags of the given players (the clan feature may be switched off, then nobody has one). */
  const clanTagsFor = async (userIds: string[]) => {
    const tags = new Map<string, { id: string; name: string; tag: string }>();
    if (!userIds.length || !isDeferredFeatureEnabled("clan")) return tags;
    const { data, error } = await db().from("clan_members").select("user_id,clans(id,name,tag)").in("user_id", userIds);
    if (error) { console.warn("[legacy-x-api] clan tags unavailable", error.message); return tags; }
    for (const row of (data ?? []) as DbRow[]) {
      const clan = firstRow(row.clans);
      if (clan) tags.set(textValue(row.user_id), { id: textValue(clan.id), name: textValue(clan.name), tag: textValue(clan.tag) });
    }
    return tags;
  };
  router.get("/public/competitive/leaderboard", asyncRoute(async (req, res) => {
    const sort = z.enum(["exp", "kd", "win"]).catch("exp").parse(req.query.sort ?? "exp");
    const limit = readLadderLimit(req.query.limit);
    const { data, error } = await db().from("competitive_leaderboard").select("position,user_id,steam_id,username,avatar,current_exp,rank_id,rank_slug,rank_name,rank_image_key,pro_league_unlocked,matches_completed,wins,losses,kills,assists,headshot_kills,deaths,kd_ratio,win_rate,played_hours,last_match_at").order("position").limit(sort === "exp" ? limit : 1000);
    legacyXError(error, "Unable to load competitive leaderboard");
    const linked = await discordLinkedUserIds(db());
    const clanTags = await clanTagsFor(((data ?? []) as DbRow[]).map((row) => textValue(row.user_id)));
    const worn = await equippedCosmeticsFor(((data ?? []) as DbRow[]).map((row) => textValue(row.user_id)));
    const rows = ((data ?? []) as DbRow[]).map((row): DbRow => ({ ...row, discord_linked: linked.has(textValue(row.user_id)), clan_tag: clanTags.get(textValue(row.user_id))?.tag ?? null, frame: worn.get(textValue(row.user_id))?.frame ?? null, name_style: worn.get(textValue(row.user_id))?.nameStyle ?? null }));
    if (sort === "exp") {
      res.json({ sort, minimumMatches: 0, entries: rows });
      return;
    }
    // K/D and win rate are only meaningful with a sample: 10 completed matches minimum.
    const metric = (row: DbRow) => Number(sort === "kd" ? row.kd_ratio : row.win_rate) || 0;
    const entries = rows
      .filter((row) => Number(row.matches_completed) >= COMPETITIVE_SORT_MIN_MATCHES)
      .sort((a, b) => metric(b) - metric(a) || Number(b.current_exp) - Number(a.current_exp) || Number(a.position) - Number(b.position))
      .slice(0, limit)
      .map((row, index) => ({ ...row, exp_position: row.position, position: index + 1 }));
    res.json({ sort, minimumMatches: COMPETITIVE_SORT_MIN_MATCHES, entries });
  }));
  router.get("/public/servers/:serverId/live-match", asyncRoute(async (req, res) => {
    const serverId = z.string().trim().min(1).max(120).parse(req.params.serverId);
    const [serverResult, snapshotResult, sessionsResult] = await Promise.all([
      db().schema("legacy_x").from("reconnect_servers").select("server_id,display_name,connect_address,gotv_address,current_map,current_mode,player_count,max_players,last_heartbeat_at").eq("server_id", serverId).maybeSingle(),
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
    const teams = hasSnapshot ? { t: normalizePlayers(snapshot?.terrorist_players), ct: normalizePlayers(snapshot?.counter_terrorist_players) } : { t: [], ct: [] };
    const spectators = hasSnapshot ? normalizePlayers(snapshot?.spectator_players) : [];
    const connectedPlayers = hasSnapshot ? [] : rosterOnly;
    // Steam avatars for the players who have a LEGACY-X account; anyone else has none and shows their initials.
    const steamIds = Array.from(new Set([...teams.t, ...teams.ct, ...spectators, ...connectedPlayers].map(player => player.steamId).filter(Boolean))).slice(0, 64);
    const avatarBySteamId = new Map<string, string>();
    if (steamIds.length > 0) {
      const { data: avatarRows, error: avatarError } = await db().from("competitive_player_profiles").select("steam_id,avatar").in("steam_id", steamIds);
      if (avatarError) console.error("Unable to load live match avatars", avatarError);
      for (const row of (avatarRows ?? []) as DbRow[]) {
        const avatar = textValue(row.avatar);
        if (avatar.startsWith("https://")) avatarBySteamId.set(textValue(row.steam_id), avatar);
      }
    }
    const withAvatar = <T extends { steamId: string }>(players: T[]) => players.map(player => ({ ...player, avatar: avatarBySteamId.get(player.steamId) ?? null }));
    res.json({
      liveMatch: {
        serverId,
        serverName: textValue(serverResult.data.display_name) || serverId,
        connectAddress: textValue(serverResult.data.connect_address) || null,
        gotvAddress: textValue(serverResult.data.gotv_address) || null,
        players: numberValue(serverResult.data.player_count),
        maxPlayers: numberValue(serverResult.data.max_players) || 10,
        map: textValue(snapshot?.map_name) || textValue(serverResult.data.current_map) || "Unknown",
        mode: textValue(serverResult.data.current_mode) || "Community",
        state: hasSnapshot ? textValue(snapshot?.state) : "unavailable",
        round: hasSnapshot ? nullableNumber(snapshot?.round_number) : null,
        score: hasSnapshot && scoreT !== null && scoreCt !== null ? { t: scoreT, ct: scoreCt } : null,
        teams: { t: withAvatar(teams.t), ct: withAvatar(teams.ct) },
        spectators: withAvatar(spectators),
        connectedPlayers: withAvatar(connectedPlayers),
        updatedAt: hasSnapshot ? reportedAt : textValue(serverResult.data.last_heartbeat_at) || null,
        availability: hasSnapshot ? "live_snapshot" : rosterOnly.length > 0 ? "roster_only" : "unavailable",
      },
    });
  }));
  router.get("/public/competitive/players/:userId", asyncRoute(async (req, res) => {
    const userId = userIdSchema.parse(req.params.userId);
    const profileColumns = "user_id,steam_id,username,avatar,current_exp,rank_id,rank_slug,rank_name,rank_image_key,pro_league_unlocked,matches_completed,wins,losses,kills,deaths,assists,headshot_kills,last_match_at,current_rank_min_exp,next_rank_id,next_rank_name,next_rank_min_exp";
    const { data, error } = await db().from("competitive_player_profiles").select(profileColumns).eq("user_id", userId).maybeSingle();
    legacyXError(error, "Unable to load competitive player profile");
    if (!data) apiError(404, "Competitive player profile was not found");
    res.json({ profile: data });
  }));
  router.get("/public/matches/:matchId/maps/:mapNumber", asyncRoute(async (req, res) => {
    const matchId = z.string().uuid("matchId must be a Legacy-X match id").parse(req.params.matchId);
    const mapNumber = z.coerce.number().int().min(0).max(99).parse(req.params.mapNumber);
    const [core, results] = await Promise.all([
      db().from("core_matches").select("id,map_name,map_number,matchzy_local_id,finished_at,result").eq("id", matchId).maybeSingle(),
      db().from("competitive_match_exp").select("team_key,outcome,exp_delta,stats,created_at,users(id,steam_id,username,avatar)").eq("match_id", matchId),
    ]);
    legacyXError(core.error || results.error, "Unable to load match");
    const rows = (results.data ?? []) as DbRow[];
    if (!core.data || rows.length === 0) apiError(404, "Match was not found");
    const score = coreRoundScore(core.data.result);
    const mapName = textValue(core.data.map_name);
    // The round timeline is optional (older plugin builds didn't send round_end); never fail the scoreboard over it.
    const rounds = await db().from("match_rounds").select("round_number,winner_side,reason,team1_score,team2_score")
      .eq("match_external_id", textValue(core.data.matchzy_local_id)).eq("map_number", mapNumber).order("round_number");
    if (rounds.error) console.warn("[legacy-x-api] match rounds unavailable", rounds.error.message);
    const detail = mapMatchDetail({
      matchId,
      mapNumber,
      results: rows.map((row) => expRowAsResult(row, score, mapName)),
      rounds: rounds.error ? [] : ((rounds.data ?? []) as DbRow[]),
      receiptPayload: recordValue(core.data.result).rank_result,
    });
    const worn = await equippedCosmeticsFor(rows.map((row) => textValue(firstRow(row.users)?.id)));
    res.json({ ...detail, teams: detail.teams.map((team) => ({ ...team, players: team.players.map((player) => ({ ...player, ...lookOf(worn, player.userId ?? "") })) })) });
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
  // Home tiles: live numbers from the plugin heartbeats (same source as the Play pages) and today's matches.
  router.get("/public/overview", asyncRoute(async (_req, res) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [servers, matches] = await Promise.all([
      loadPlayServers(),
      db().from("core_match_history").select("match_id").gte("started_at", today.toISOString()).limit(1_000),
    ]);
    legacyXError(matches.error, "Unable to load public overview");
    const online = servers.filter(server => server.status !== "offline");
    const playersIn = (mode: string) => online.filter(server => server.mode === mode).reduce((total, server) => total + server.players, 0);
    res.json({
      playersOnline: online.reduce((total, server) => total + server.players, 0),
      liveServers: online.length,
      matchesToday: (matches.data ?? []).length,
      modes: { "5x5": playersIn("5x5"), fun: playersIn("fun"), pro: playersIn("pro") },
    });
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
  /**
   * Profile page in one response. Rank, leaderboard position, trust and penalty history are always
   * public; stats / matches & maps / loadout honour the player's "What others can see" switches for
   * everyone except the owner and staff — hidden sections are left out of the payload.
   */
  router.get("/profile/:userId/overview", optionalUserRoute(async (req, res, viewer) => {
    const raw = String(req.params.userId ?? "");
    if (raw === "me" && !viewer) apiError(401, "Sign in to view your profile");
    const userId = viewer ? await resolveUserId(raw, viewer) : await resolveUserId(raw, { id: "" } as LegacyUser);
    const [userResult, progressionResult, positionResult, expResult, penaltiesResult, viewerStaffResult, role] = await Promise.all([
      db().from("users").select("id,steam_id,username,avatar,created_at,hidden_profile_sections").eq("id", userId).maybeSingle(),
      db().from("competitive_player_profiles").select("current_exp,rank_id,rank_name,rank_image_key,pro_league_unlocked,matches_completed,wins,losses,kills,deaths,assists,headshot_kills,last_match_at,current_rank_min_exp,next_rank_id,next_rank_name,next_rank_min_exp").eq("user_id", userId).maybeSingle(),
      db().from("competitive_leaderboard").select("position").eq("user_id", userId).maybeSingle(),
      db().from("competitive_match_exp").select("match_id,team_key,outcome,exp_before,exp_delta,exp_after,exp_breakdown,stats,created_at,core_matches(map_name,map_number,finished_at,result)").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      db().from("penalties").select("*,users!penalties_user_id_fkey(username,steam_id,avatar)").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      viewer ? db().from("staff").select("id").eq("user_id", viewer.id).eq("status", "active").maybeSingle() : Promise.resolve({ data: null, error: null }),
      profileRoleFor(userId),
    ]);
    legacyXError(userResult.error || progressionResult.error || positionResult.error || expResult.error || penaltiesResult.error || viewerStaffResult.error, "Unable to load profile");
    const user = userResult.data as DbRow | null;
    if (!user) apiError(404, "Player was not found");
    const steamId = textValue(user.steam_id);
    const isOwner = viewer?.id === userId;
    const isStaff = Boolean(viewerStaffResult.data);
    const ownerHidden = hiddenSectionsValue(user.hidden_profile_sections);
    const hidden = hiddenForViewer(ownerHidden, { isOwner, isStaff });
    const progression = progressionResult.data as DbRow | null;
    const expRows = (expResult.data ?? []) as DbRow[];

    const [sessionResult, penaltyCount, steamCreatedAt, loadout, steamMedia] = await Promise.all([
      db().schema("legacy_x").from("reconnect_sessions").select("server_id,connected_at").eq("steam_id", steamId).is("disconnected_at", null).order("connected_at", { ascending: false }).limit(1).maybeSingle(),
      role !== "Player" ? db().from("penalties").select("id", { count: "exact", head: true }).eq("admin_name", textValue(user.username)) : Promise.resolve({ count: 0, error: null }),
      fetchSteamAccountCreatedAt(steamId),
      hidden.includes("loadout") ? Promise.resolve(null) : loadSkinchangerLoadout(req, userId),
      resolveSteamProfileMedia(steamId),
    ]);
    legacyXError(sessionResult.error || penaltyCount.error, "Unable to load profile");

    // Playing now: an open session on a server whose heartbeat is fresh.
    let presence: { serverId: string; serverName: string; connectAddress: string | null; map: string } | null = null;
    const session = sessionResult.data as DbRow | null;
    if (session) {
      const live = (await loadPlayServers()).find((server) => server.id === textValue(session.server_id) && server.status !== "offline");
      if (live) presence = { serverId: live.id, serverName: live.name, connectAddress: live.connectAddress, map: live.map };
    }

    const ownerExtras = role === "Owner" ? await loadOwnerProfileExtras(userId, viewer?.id ?? null) : {};
    const penalties = await mapPenaltiesWithProfileIdentities((penaltiesResult.data ?? []) as DbRow[], db());
    const activePenalty = penalties.find((penalty) => !penalty.isUnbanned && (penalty.isPermanent || !penalty.expiresAt || Date.parse(String(penalty.expiresAt)) > Date.now()));
    res.json({
      user: {
        id: textValue(user.id),
        steamId,
        username: textValue(user.username),
        avatar: textValue(user.avatar),
        role,
        memberSince: timestampValue(user.created_at) || null,
        steamBackground: steamMedia.background,
        steamMedia: { backgroundVideo: steamMedia.backgroundVideo, animatedAvatar: steamMedia.animatedAvatar, avatarFrame: steamMedia.avatarFrame },
        ...(await (async () => { const mine = (await equippedCosmeticsFor([textValue(user.id)])).get(textValue(user.id)); return { frame: mine?.frame ?? null, nameStyle: mine?.nameStyle ?? null }; })()),
      },
      viewer: { isOwner, isStaff },
      // The owner's own switches, so the popover shows them; null for everyone else.
      visibility: isOwner ? Object.fromEntries(PROFILE_SECTIONS.map((section) => [section, !ownerHidden.includes(section)])) : null,
      hidden,
      competitive: progression ? {
        exp: numberValue(progression.current_exp),
        rankId: numberValue(progression.rank_id),
        rankName: textValue(progression.rank_name),
        rankImageKey: textValue(progression.rank_image_key) || null,
        currentRankMinExp: numberValue(progression.current_rank_min_exp),
        nextRankName: textValue(progression.next_rank_name) || null,
        nextRankMinExp: progression.next_rank_min_exp == null ? null : numberValue(progression.next_rank_min_exp),
        proLeagueUnlocked: Boolean(progression.pro_league_unlocked),
        position: positionResult.data ? numberValue((positionResult.data as DbRow).position) : null,
        // The player's own daily / weekly EXP limits; only the owner sees them.
        expLimits: isOwner ? expLimitUsage(expRows.map((row) => ({ exp_delta: numberValue(row.exp_delta), created_at: textValue(row.created_at) }))) : null,
      } : null,
      lastPlayedAt: timestampValue(progression?.last_match_at) || null,
      trust: { steamAccountCreatedAt: steamCreatedAt, activePenalty: activePenalty ? { id: activePenalty.id, type: activePenalty.type } : null },
      stats: hidden.includes("stats") ? null : profileStats(progression),
      recentMatches: hidden.includes("matches") ? null : expRows.slice(0, 10).map(mapExpRecentMatch),
      maps: hidden.includes("matches") ? null : mapWinRates(expRows),
      penalties: penalties.sort((a, b) => Number(b === activePenalty) - Number(a === activePenalty)).slice(0, 5),
      penaltyCount: penalties.length,
      loadout: loadout ? loadoutShowcase(loadout.entries as DbRow[]) : null,
      staff: staffCard(role, penaltyCount.count ?? 0),
      presence,
      discordLinked: (await discordLinkedUserIds(db())).has(userId),
      clan: (await clanTagsFor([userId])).get(userId) ?? null,
      ...ownerExtras,
    });
  }));
  /** Respect count and whether the viewer gave one. Null while the migration is not applied, so the button stays hidden. */
  const respectState = async (targetId: string, viewerId: string | null) => {
    const [count, given] = await Promise.all([
      db().from("profile_respect").select("giver_user_id", { count: "exact", head: true }).eq("target_user_id", targetId),
      viewerId ? db().from("profile_respect").select("giver_user_id").eq("target_user_id", targetId).eq("giver_user_id", viewerId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    if (isMissingTableError(count.error) || isMissingTableError(given.error)) return null;
    legacyXError(count.error || given.error, "Unable to load respect");
    return { count: count.count ?? 0, given: Boolean(given.data) };
  };
  /** What only the Owner's profile shows. Each part is left out (not faked) when it has no data or its table is missing. */
  const loadOwnerProfileExtras = async (ownerId: string, viewerId: string | null) => {
    const [respect, extras, team, updates] = await Promise.all([
      respectState(ownerId, viewerId),
      db().from("owner_profile").select("links,message").eq("user_id", ownerId).maybeSingle(),
      db().from("staff").select("role,users(steam_id,username,avatar)").eq("status", "active").limit(50),
      db().from("announcements").select("id,title,created_at").order("created_at", { ascending: false }).limit(5),
    ]);
    const extrasRow = isMissingTableError(extras.error) ? null : extras.data as DbRow | null;
    if (!isMissingTableError(extras.error)) legacyXError(extras.error, "Unable to load the owner profile");
    // Team and updates are extras: if either cannot be read the card is left out, the profile still loads.
    const links = ownerLinks(extrasRow?.links);
    const message = textValue(extrasRow?.message).trim();
    const teamList = team.error ? [] : ownerTeam((team.data ?? []) as DbRow[]);
    const updateList = updates.error ? [] : ownerUpdates((updates.data ?? []) as DbRow[]);
    return {
      ...(respect ? { respect } : {}),
      ...(links.length ? { links } : {}),
      ...(message ? { message } : {}),
      ...(teamList.length ? { team: teamList } : {}),
      ...(updateList.length ? { updates: updateList } : {}),
    };
  };
  const setRespect = (give: boolean) => userRoute(async (req, res, user) => {
    const targetId = await resolveUserId(req.params.userId, user);
    if (targetId === user.id) apiError(400, "You cannot give respect to yourself");
    if (await profileRoleFor(targetId) !== "Owner") apiError(404, "Respect can only be given to the Owner");
    const result = give
      ? await db().from("profile_respect").upsert({ target_user_id: targetId, giver_user_id: user.id }, { onConflict: "target_user_id,giver_user_id", ignoreDuplicates: true })
      : await db().from("profile_respect").delete().eq("target_user_id", targetId).eq("giver_user_id", user.id);
    if (isMissingTableError(result.error)) apiError(503, "Respect is not available yet");
    legacyXError(result.error, "Unable to save respect");
    res.json(await respectState(targetId, user.id) ?? { count: 0, given: false });
  });
  router.post("/profile/:userId/respect", sensitiveMutationRateLimit, setRespect(true));
  router.delete("/profile/:userId/respect", sensitiveMutationRateLimit, setRespect(false));
  // Coin wallet. A player sees only their own balance and ledger; coins are added by an Owner (or later by game events)
  // and taken only by the thing they pay for (e.g. a clan fee), always through wallet_apply.
  router.get("/wallet/me", userRoute(async (_req, res, user) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json({ ...(await loadWallet(db(), user.id)), earn: earnRules(), clanPrices: clanPrices(), summary: await loadWalletSummary(db(), user.id, new Date(), (message, error) => console.error(`[legacy-x-api] ${message}`, error)) });
    } catch (error) {
      if (isMissingTableError(error)) apiError(503, "The wallet is not available yet");
      throw error;
    }
  }));
  router.post("/wallet/grant", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    await requireOwnerStaffRole(user.id);
    const input = walletGrantSchema.parse(req.body);
    let targetId = input.userId ?? "";
    if (!targetId) {
      const { data, error } = await db().from("users").select("id").eq("steam_id", input.steamId ?? "").maybeSingle();
      legacyXError(error, "Unable to find the player");
      if (!data) apiError(404, "Player was not found");
      targetId = textValue((data as DbRow).id);
    }
    try {
      const result = await applyWalletChange(db(), { userId: targetId, amount: input.amount, kind: "grant", reason: input.reason, ref: input.ref ?? null, actor: user.id });
      if (result.applied) {
        const { error: auditError } = await db().from("audit_logs").insert({
          actor_type: "user",
          actor_id: user.id,
          action: "wallet.grant",
          target_type: "wallet",
          target_id: targetId,
          metadata: { amount: input.amount, reason: input.reason, balance: result.balance },
        });
        if (auditError) console.error("Unable to audit wallet grant", auditError);
      }
      res.status(result.applied ? 201 : 200).json({ userId: targetId, balance: result.balance, applied: result.applied });
    } catch (error) {
      if (error instanceof NotEnoughCoinsError) apiError(402, "Not enough LX");
      if (isMissingTableError(error)) apiError(503, "The wallet is not available yet");
      throw error;
    }
  }));
  router.post("/wallet/penalty", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    await requireOwnerStaffRole(user.id);
    const input = walletPenaltySchema.parse(req.body);
    let targetId = input.userId ?? "";
    if (!targetId) {
      const { data, error } = await db().from("users").select("id").eq("steam_id", input.steamId ?? "").maybeSingle();
      legacyXError(error, "Unable to find the player");
      if (!data) apiError(404, "Player was not found");
      targetId = textValue((data as DbRow).id);
    }
    try {
      const result = await penalizeWallet(db(), { userId: targetId, amount: input.amount, reason: input.reason, ref: input.ref ?? null, actor: user.id });
      if (result.applied) {
        const { error: auditError } = await db().from("audit_logs").insert({
          actor_type: "user",
          actor_id: user.id,
          action: "wallet.penalty",
          target_type: "wallet",
          target_id: targetId,
          metadata: { requested: input.amount, taken: result.taken, reason: input.reason, balance: result.balance },
        });
        if (auditError) console.error("Unable to audit wallet penalty", auditError);
      }
      // `taken` can be less than asked: a wallet never goes below zero.
      res.status(result.applied ? 201 : 200).json({ userId: targetId, balance: result.balance, taken: result.taken, applied: result.applied });
    } catch (error) {
      if (isMissingTableError(error)) apiError(503, "The wallet is not available yet");
      throw error;
    }
  }));
  /** The Owner writes their own links and message. */
  router.put("/profile/me/owner", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    if (await profileRoleFor(user.id) !== "Owner") apiError(403, "Only the Owner can edit this");
    const input = ownerProfileSchema.parse(req.body);
    const row: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
    if (input.links !== undefined) row.links = input.links.map((link) => (link.label ? { url: link.url, label: link.label } : { url: link.url }));
    if (input.message !== undefined) row.message = input.message || null;
    const { error } = await db().from("owner_profile").upsert(row, { onConflict: "user_id" });
    if (isMissingTableError(error)) apiError(503, "The owner profile is not available yet");
    legacyXError(error, "Unable to save the owner profile");
    const saved = await db().from("owner_profile").select("links,message").eq("user_id", user.id).maybeSingle();
    legacyXError(saved.error, "Unable to load the owner profile");
    res.json({ links: ownerLinks((saved.data as DbRow | null)?.links), message: textValue((saved.data as DbRow | null)?.message) || null });
  }));
  router.put("/profile/me", userRoute(async (req, res, user) => {
    const { hiddenSections, ...fields } = profileUpdateSchema.parse(req.body);
    const updates: Record<string, unknown> = { ...fields };
    if (hiddenSections) updates.hidden_profile_sections = PROFILE_HIDEABLE_SECTIONS.filter((section) => hiddenSections.includes(section));
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
  // Public like the rest of the profile page; "FACEIT stats" can be hidden by the player.
  router.get("/profile/:userId/faceit", optionalUserRoute(async (req, res, user) => {
    if (req.params.userId === "me" && !user) apiError(401, "Sign in to view your profile");
    const profile = await loadProfile(await resolveUserId(req.params.userId, user ?? ({ id: "" } as LegacyUser)));
    if ((await hiddenSectionsFor(textValue(profile.user.id), user?.id ?? "")).includes("faceit")) {
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
    if ((await hiddenSectionsFor(userId, user.id)).includes("matches")) {
      res.json([]);
      return;
    }
    // Ranked matches carry their EXP change and breakdown; older history rows (before the rank system) don't.
    const ranked = await db().from("competitive_match_exp")
      .select("match_id,team_key,outcome,exp_before,exp_delta,exp_after,exp_breakdown,stats,created_at,core_matches(map_name,map_number,finished_at,result)")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(30);
    legacyXError(ranked.error, "Unable to load match history");
    res.json(((ranked.data ?? []) as DbRow[]).map(mapExpRecentMatch));
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

  // Settings → Notifications (users.notification_prefs). Penalty notices are always on.
  const notificationPrefsSchema = z.object({ tournaments: z.boolean().optional(), rankChanges: z.boolean().optional() }).strict();
  const mapNotificationPrefs = (value: unknown) => {
    const prefs = recordValue(value);
    return { tournaments: prefs.tournaments !== false, rankChanges: prefs.rank_changes !== false, penalties: true as const };
  };
  router.get("/settings/notifications", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("users").select("notification_prefs").eq("id", user.id).maybeSingle();
    legacyXError(error, "Unable to load notification settings");
    res.json(mapNotificationPrefs(data?.notification_prefs));
  }));
  router.put("/settings/notifications", userRoute(async (req, res, user) => {
    const input = notificationPrefsSchema.parse(req.body);
    const { data: current, error: readError } = await db().from("users").select("notification_prefs").eq("id", user.id).maybeSingle();
    legacyXError(readError, "Unable to load notification settings");
    const next = { ...recordValue(current?.notification_prefs) };
    if (input.tournaments !== undefined) next.tournaments = input.tournaments;
    if (input.rankChanges !== undefined) next.rank_changes = input.rankChanges;
    const { error } = await db().from("users").update({ notification_prefs: next }).eq("id", user.id);
    legacyXError(error, "Unable to save notification settings");
    res.json(mapNotificationPrefs(next));
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

  // Cosmetics (avatar frames): purely visual. Free ones are open to everyone, coin ones are bought once, achievement ones are granted, never sold.
  const cosmeticRateLimit = rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : 30,
    skip: (req) => req.method === "GET",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please retry shortly." },
  });
  router.use("/cosmetics", cosmeticRateLimit);
  const cosmeticIdSchema = z.string().regex(/^[a-z0-9-]{2,40}$/);
  const COSMETIC_KINDS = ["frame", "name_color", "name_glow"] as const;
  type CosmeticKind = (typeof COSMETIC_KINDS)[number];
  const loadCosmeticCatalog = async () => {
    const { data, error } = await db().from("cosmetic_items").select("id,kind,name_en,name_mn,unlock,price,requirement,sort,color,glow,fx,rarity,featured").eq("enabled", true).order("sort");
    legacyXError(error, "Unable to load cosmetics");
    return (data ?? []) as DbRow[];
  };
  /** What each of these players wears: their frame (item id) and name style (plain colours); players with nothing are left out. */
  const equippedCosmeticsFor = async (userIds: string[]) => {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    const worn = new Map<string, { frame: string | null; nameStyle: { color: string | null; glow: string | null; colorFx: string | null; glowFx: string | null } | null }>();
    if (!ids.length) return worn;
    const [equipped, catalog] = await Promise.all([db().from("cosmetic_equipped").select("user_id,kind,item_id").in("user_id", ids), loadCosmeticCatalog().catch((error) => { console.error("[legacy-x-api] unable to load cosmetics", error?.message); return [] as DbRow[]; })]);
    if (equipped.error) { console.error("[legacy-x-api] unable to load equipped cosmetics", equipped.error.message); return worn; }
    const items = new Map(catalog.map((item) => [textValue(item.id), item]));
    for (const row of (equipped.data ?? []) as DbRow[]) {
      const userId = textValue(row.user_id);
      const item = items.get(textValue(row.item_id));
      if (!item) continue;
      const entry = worn.get(userId) ?? { frame: null, nameStyle: null };
      if (row.kind === "frame") entry.frame = textValue(item.id);
      else {
        const style = entry.nameStyle ?? { color: null, glow: null, colorFx: null, glowFx: null };
        if (row.kind === "name_color") { style.color = textValue(item.color) || null; style.colorFx = textValue(item.fx) || null; }
        if (row.kind === "name_glow") { style.glow = textValue(item.glow) || null; style.glowFx = textValue(item.fx) || null; }
        entry.nameStyle = style;
      }
      worn.set(userId, entry);
    }
    return worn;
  };
  /** The frame and name style fields every player card carries (null when nothing is worn). */
  const lookOf = (worn: Awaited<ReturnType<typeof equippedCosmeticsFor>>, userId: string) => ({ frame: worn.get(userId)?.frame ?? null, nameStyle: worn.get(userId)?.nameStyle ?? null });
  const cosmeticView = (item: DbRow, ownedIds: Set<string>, owners: Map<string, number>) => ({
    id: textValue(item.id),
    name: textValue(item.name_en),
    nameMn: textValue(item.name_mn),
    unlock: textValue(item.unlock),
    price: numberValue(item.price),
    requirement: textValue(item.requirement),
    owned: textValue(item.unlock) === "free" || ownedIds.has(textValue(item.id)),
    rarity: Math.min(4, Math.max(1, numberValue(item.rarity) || 1)),
    featured: Boolean(item.featured),
    /** How many players own it (null for free items, which everyone has). */
    owners: textValue(item.unlock) === "free" ? null : owners.get(textValue(item.id)) ?? 0,
    ...(item.color ? { color: textValue(item.color) } : {}),
    ...(item.glow ? { glow: textValue(item.glow) } : {}),
    ...(item.fx ? { fx: textValue(item.fx) } : {}),
  });
  router.get("/cosmetics", userRoute(async (_req, res, user) => {
    const [catalog, owned, worn, equippedRows, everyOwned, players] = await Promise.all([
      loadCosmeticCatalog(),
      db().from("cosmetic_owned").select("item_id").eq("user_id", user.id),
      equippedCosmeticsFor([user.id]),
      db().from("cosmetic_equipped").select("kind,item_id").eq("user_id", user.id),
      db().from("cosmetic_owned").select("item_id").limit(100000),
      db().from("users").select("id", { count: "exact", head: true }),
    ]);
    legacyXError(owned.error || equippedRows.error, "Unable to load your cosmetics");
    // Counts are cosmetic extras: if they cannot be read the shop still works, just without them.
    const owners = new Map<string, number>();
    if (!everyOwned.error) for (const row of (everyOwned.data ?? []) as DbRow[]) owners.set(textValue(row.item_id), (owners.get(textValue(row.item_id)) ?? 0) + 1);
    const ownedIds = new Set(((owned.data ?? []) as DbRow[]).map((row) => textValue(row.item_id)));
    const wearing = new Map(((equippedRows.data ?? []) as DbRow[]).map((row) => [textValue(row.kind), textValue(row.item_id)]));
    const ofKind = (kind: CosmeticKind) => catalog.filter((item) => item.kind === kind).map((item) => cosmeticView(item, ownedIds, owners));
    res.json({
      players: players.error ? null : players.count ?? 0,
      equippedFrame: worn.get(user.id)?.frame ?? null,
      equippedNameColor: wearing.get("name_color") ?? null,
      equippedNameGlow: wearing.get("name_glow") ?? null,
      frames: ofKind("frame"),
      nameColors: ofKind("name_color"),
      nameGlows: ofKind("name_glow"),
    });
  }));
  router.post("/cosmetics/:itemId/buy", userRoute(async (req, res, user) => {
    const itemId = cosmeticIdSchema.parse(req.params.itemId);
    const item = (await loadCosmeticCatalog()).find((entry) => textValue(entry.id) === itemId);
    if (!item) apiError(404, "Item not found");
    if (textValue(item.unlock) !== "coin") apiError(409, "This item is not for sale", "cosmetic_not_for_sale");
    const price = numberValue(item.price);
    const label = item.kind === "frame" ? "Frame" : item.kind === "name_color" ? "Name colour" : "Name glow";
    // The ref is per player and item, so a double click or a retry charges once.
    try {
      await applyWalletChange(legacyXDb(), { userId: user.id, amount: -price, kind: "spend", reason: `${label}: ${textValue(item.name_en)}`, ref: `cosmetic:${itemId}`, actor: user.id });
    } catch (error) {
      if (error instanceof NotEnoughCoinsError) apiError(402, `This costs ${price} LX`, "cosmetic_no_coins");
      throw error;
    }
    const { error } = await db().from("cosmetic_owned").upsert({ user_id: user.id, item_id: itemId, source: "coin" }, { onConflict: "user_id,item_id", ignoreDuplicates: true });
    if (error) {
      await applyWalletChange(legacyXDb(), { userId: user.id, amount: price, kind: "refund", reason: `${label} purchase failed`, ref: `cosmetic:${itemId}:refund`, actor: user.id }).catch((refundError) => console.error("[legacy-x-api] cosmetic refund failed", refundError));
      legacyXError(error, "Unable to save the purchase");
    }
    await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "cosmetic.buy", target_type: "cosmetic_items", target_id: itemId, metadata: { price } });
    res.status(201).json({ owned: true });
  }));
  // Wear one, or take it off with item: null. The older { frame } body still works.
  router.put("/cosmetics/equip", userRoute(async (req, res, user) => {
    const input = z.union([
      z.object({ frame: cosmeticIdSchema.nullable() }).strict().transform((value) => ({ kind: "frame" as CosmeticKind, item: value.frame })),
      z.object({ kind: z.enum(COSMETIC_KINDS), item: cosmeticIdSchema.nullable() }).strict(),
    ]).parse(req.body);
    if (input.item === null) {
      const { error } = await db().from("cosmetic_equipped").delete().eq("user_id", user.id).eq("kind", input.kind);
      legacyXError(error, "Unable to take it off");
      res.json({ kind: input.kind, item: null, equippedFrame: input.kind === "frame" ? null : undefined });
      return;
    }
    const item = (await loadCosmeticCatalog()).find((entry) => textValue(entry.id) === input.item);
    if (!item || item.kind !== input.kind) apiError(404, "Item not found");
    if (textValue(item.unlock) !== "free") {
      const { data, error: ownedError } = await db().from("cosmetic_owned").select("item_id").eq("user_id", user.id).eq("item_id", input.item).maybeSingle();
      legacyXError(ownedError, "Unable to check your cosmetics");
      if (!data) apiError(403, "You do not own this yet", "cosmetic_not_owned");
    }
    const { error } = await db().from("cosmetic_equipped").upsert({ user_id: user.id, kind: input.kind, item_id: input.item, updated_at: new Date().toISOString() }, { onConflict: "user_id,kind" });
    legacyXError(error, "Unable to wear it");
    res.json({ kind: input.kind, item: input.item, equippedFrame: input.kind === "frame" ? input.item : undefined });
  }));

  // Community collections: a snapshot of someone's loadout that anyone can apply. Free; likes and applies count once per account.
  const MAX_COLLECTIONS_PER_PLAYER = 5;
  const collectionRateLimit = rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 1_000 : 20,
    skip: (req) => req.method === "GET",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many collection requests. Please retry shortly." },
  });
  router.use("/skinchanger/collections", collectionRateLimit);
  const collectionShareSchema = z.object({
    name: z.string().trim().min(3).max(40),
    description: z.string().trim().max(120).default(""),
  }).strict();
  const collectionIdSchema = z.string().uuid();

  router.get("/skinchanger/collections", userRoute(async (req, res, user) => {
    const input = z.object({
      sort: z.enum(["popular", "new", "mine"]).default("popular"),
      query: z.string().trim().max(40).optional(),
    }).parse(req.query);
    let rowsQuery = db().from("skin_collections")
      .select("id,owner_user_id,name,description,entries,item_count,likes_count,applies_count,created_at")
      .is("deleted_at", null)
      .limit(60);
    if (input.sort === "mine") rowsQuery = rowsQuery.eq("owner_user_id", user.id);
    const search = (input.query ?? "").replace(/[%_\\,()]/g, " ").trim();
    if (search) rowsQuery = rowsQuery.ilike("name", `%${search}%`);
    rowsQuery = input.sort === "new"
      ? rowsQuery.order("created_at", { ascending: false })
      : rowsQuery.order("applies_count", { ascending: false }).order("likes_count", { ascending: false }).order("created_at", { ascending: false });
    const { data, error } = await rowsQuery;
    legacyXError(error, "Unable to load collections");
    const rows = (data ?? []) as DbRow[];
    const ownerIds = Array.from(new Set(rows.map((row) => textValue(row.owner_user_id))));
    const owners = new Map<string, DbRow>();
    if (ownerIds.length) {
      const { data: users, error: usersError } = await db().from("users").select("id,steam_id,username,avatar").in("id", ownerIds);
      legacyXError(usersError, "Unable to load collection authors");
      for (const owner of (users ?? []) as DbRow[]) owners.set(textValue(owner.id), owner);
    }
    const previewEntries = new Map<string, DbRow[]>(rows.map((row) => [textValue(row.id), (Array.isArray(row.entries) ? row.entries as DbRow[] : []).slice(0, 8)]));
    const previewIds = Array.from(new Set(Array.from(previewEntries.values()).flat().map((entry) => textValue(entry.catalog_item_id)).filter(Boolean)));
    const catalog = new Map<string, DbRow>();
    if (previewIds.length) {
      const { data: items, error: itemsError } = await db().from("skinchanger_catalog_items").select("id,weapon_class,display_name,image_key,metadata").in("id", previewIds);
      legacyXError(itemsError, "Unable to load collection items");
      for (const item of (items ?? []) as DbRow[]) catalog.set(textValue(item.id), item);
    }
    const liked = new Set<string>();
    if (rows.length) {
      const { data: likes, error: likesError } = await db().from("skin_collection_likes").select("collection_id").eq("user_id", user.id).in("collection_id", rows.map((row) => textValue(row.id)));
      legacyXError(likesError, "Unable to load likes");
      for (const like of (likes ?? []) as DbRow[]) liked.add(textValue(like.collection_id));
    }
    res.json({
      collections: rows.map((row) => {
        const owner = owners.get(textValue(row.owner_user_id)) ?? {};
        return {
          id: textValue(row.id),
          name: textValue(row.name),
          description: textValue(row.description),
          author: { steamId: textValue(owner.steam_id), username: textValue(owner.username), avatar: textValue(owner.avatar) },
          createdAt: timestampValue(row.created_at),
          applies: numberValue(row.applies_count),
          likes: numberValue(row.likes_count),
          liked: liked.has(textValue(row.id)),
          mine: textValue(row.owner_user_id) === user.id,
          itemCount: numberValue(row.item_count),
          items: (previewEntries.get(textValue(row.id)) ?? []).map((entry) => {
            const item = catalog.get(textValue(entry.catalog_item_id));
            const rarity = item ? recordValue(item.metadata).rarity : null;
            return item ? {
              slot: textValue(entry.slot),
              weaponClass: textValue(item.weapon_class) || null,
              name: textValue(item.display_name),
              imageUrl: staticStorageUrl(req, textValue(item.image_key) || null),
              rarity: typeof rarity === "string" ? rarity : null,
            } : null;
          }).filter(Boolean),
        };
      }),
    });
  }));

  // One collection with every item it holds, for the detail view.
  router.get("/skinchanger/collections/:collectionId", userRoute(async (req, res, user) => {
    const collectionId = collectionIdSchema.parse(req.params.collectionId);
    const { data, error } = await db().from("skin_collections")
      .select("id,owner_user_id,name,description,entries,item_count,likes_count,applies_count,created_at")
      .eq("id", collectionId).is("deleted_at", null).maybeSingle();
    legacyXError(error, "Unable to load the collection");
    if (!data) apiError(404, "Collection not found");
    const row = data as DbRow;
    const { data: owner, error: ownerError } = await db().from("users").select("steam_id,username,avatar").eq("id", textValue(row.owner_user_id)).maybeSingle();
    legacyXError(ownerError, "Unable to load the collection's author");
    const entries = (Array.isArray(row.entries) ? row.entries : []) as DbRow[];
    const ids = Array.from(new Set(entries.map((entry) => textValue(entry.catalog_item_id)).filter(Boolean)));
    const catalog = new Map<string, DbRow>();
    if (ids.length) {
      const { data: items, error: itemsError } = await db().from("skinchanger_catalog_items").select("id,weapon_class,display_name,image_key,metadata").in("id", ids);
      legacyXError(itemsError, "Unable to load collection items");
      for (const item of (items ?? []) as DbRow[]) catalog.set(textValue(item.id), item);
    }
    const { data: like, error: likeError } = await db().from("skin_collection_likes").select("user_id").eq("collection_id", collectionId).eq("user_id", user.id).maybeSingle();
    legacyXError(likeError, "Unable to load likes");
    const ownerRow = (owner ?? {}) as DbRow;
    res.json({
      collection: {
        id: textValue(row.id),
        name: textValue(row.name),
        description: textValue(row.description),
        author: { steamId: textValue(ownerRow.steam_id), username: textValue(ownerRow.username), avatar: textValue(ownerRow.avatar) },
        createdAt: timestampValue(row.created_at),
        applies: numberValue(row.applies_count),
        likes: numberValue(row.likes_count),
        liked: Boolean(like),
        mine: textValue(row.owner_user_id) === user.id,
        itemCount: numberValue(row.item_count),
        items: entries.map((entry) => {
          const item = catalog.get(textValue(entry.catalog_item_id));
          if (!item) return null;
          const options = recordValue(entry.options);
          const rarity = recordValue(item.metadata).rarity;
          return {
            slot: textValue(entry.slot),
            teamScope: textValue(entry.team_scope) || "all",
            weaponClass: textValue(item.weapon_class) || null,
            name: textValue(item.display_name),
            imageUrl: staticStorageUrl(req, textValue(item.image_key) || null),
            rarity: typeof rarity === "string" ? rarity : null,
            wear: typeof options.wear === "number" ? options.wear : null,
            statTrak: options.statTrak === true,
            stickers: Array.isArray(options.stickers) ? options.stickers.length : 0,
            hasCharm: Boolean(options.charm),
          };
        }).filter(Boolean),
      },
    });
  }));

  // Shares what the player has equipped right now.
  router.post("/skinchanger/collections", userRoute(async (req, res, user) => {
    const input = collectionShareSchema.parse(req.body);
    const current = await loadSkinchangerLoadout(req, user.id);
    const entries = ((current?.entries ?? []) as DbRow[]).filter((entry) => entry.skinchanger_catalog_items);
    if (!entries.length) apiError(400, "Equip something in your loadout before sharing it");
    const { count, error: countError } = await db().from("skin_collections").select("id", { count: "exact", head: true }).eq("owner_user_id", user.id).is("deleted_at", null);
    legacyXError(countError, "Unable to check your collections");
    if ((count ?? 0) >= MAX_COLLECTIONS_PER_PLAYER) apiError(409, `You can share up to ${MAX_COLLECTIONS_PER_PLAYER} collections. Delete one first.`);
    const snapshot = entries.map((entry) => ({ slot: entry.slot, slot_key: entry.slot_key, team_scope: entry.team_scope, catalog_item_id: entry.catalog_item_id, options: entry.options }));
    const { data, error } = await db().from("skin_collections")
      .insert({ owner_user_id: user.id, name: input.name, description: input.description, entries: snapshot, item_count: snapshot.length })
      .select("id")
      .single();
    legacyXError(error, "Unable to share the collection");
    await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "skinchanger.collection.share", target_type: "skin_collections", target_id: textValue((data as DbRow).id), metadata: { name: input.name, itemCount: snapshot.length } });
    res.status(201).json({ id: textValue((data as DbRow).id) });
  }));

  router.delete("/skinchanger/collections/:collectionId", userRoute(async (req, res, user) => {
    const collectionId = collectionIdSchema.parse(req.params.collectionId);
    const { data, error } = await db().from("skin_collections").select("id,owner_user_id").eq("id", collectionId).is("deleted_at", null).maybeSingle();
    legacyXError(error, "Unable to load the collection");
    if (!data) apiError(404, "Collection not found");
    const owner = textValue((data as DbRow).owner_user_id);
    if (owner !== user.id) {
      const staff = await loadModerator(user.id);
      if (!staff || !mayModerateClans(textValue(staff.role), staff.permissions)) apiError(403, "Only the creator or a Manager can remove this collection");
    }
    const { error: deleteError } = await db().from("skin_collections").update({ deleted_at: new Date().toISOString() }).eq("id", collectionId);
    legacyXError(deleteError, "Unable to remove the collection");
    await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "skinchanger.collection.delete", target_type: "skin_collections", target_id: collectionId, metadata: { byOwner: owner === user.id } });
    res.json({ removed: true });
  }));

  router.put("/skinchanger/collections/:collectionId/like", userRoute(async (req, res, user) => {
    const collectionId = collectionIdSchema.parse(req.params.collectionId);
    const input = z.object({ liked: z.boolean() }).strict().parse(req.body);
    const { data, error } = await db().rpc("skin_collection_set_like", { p_collection_id: collectionId, p_user_id: user.id, p_liked: input.liked });
    legacyXError(error, "Unable to save the like");
    res.json({ likes: numberValue(data), liked: input.liked });
  }));

  // Replaces the player's whole loadout with the collection's look (the web asks first).
  router.post("/skinchanger/collections/:collectionId/apply", userRoute(async (req, res, user) => {
    const collectionId = collectionIdSchema.parse(req.params.collectionId);
    const { data, error } = await db().from("skin_collections").select("id,entries").eq("id", collectionId).is("deleted_at", null).maybeSingle();
    legacyXError(error, "Unable to load the collection");
    if (!data) apiError(404, "Collection not found");
    const stored = (Array.isArray((data as DbRow).entries) ? (data as DbRow).entries : []) as DbRow[];
    const ids = Array.from(new Set(stored.map((entry) => textValue(entry.catalog_item_id)).filter(Boolean)));
    const { data: active, error: activeError } = await db().from("skinchanger_catalog_items").select("id").eq("is_active", true).in("id", ids);
    legacyXError(activeError, "Unable to check the collection's items");
    const available = new Set(((active ?? []) as DbRow[]).map((item) => textValue(item.id)));
    const entries = stored.filter((entry) => available.has(textValue(entry.catalog_item_id)));
    if (!entries.length) apiError(409, "None of this collection's items are available any more");
    const { data: version, error: saveError } = await db().rpc("save_skinchanger_loadout", { p_user_id: user.id, p_entries: entries });
    legacyXError(saveError, "Unable to apply the collection");
    const { data: counted, error: markError } = await db().rpc("skin_collection_mark_applied", { p_collection_id: collectionId, p_user_id: user.id });
    if (markError) console.error("Unable to count a collection apply", markError);
    await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "skinchanger.collection.apply", target_type: "skinchanger_loadouts", target_id: user.id, metadata: { collectionId, version, applied: entries.length, skipped: stored.length - entries.length } });
    res.json({ version: numberValue(version), applied: entries.length, skipped: stored.length - entries.length, counted: counted === true });
  }));

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
      // audit_logs.target_id is a uuid and entries have none: the target is the user's loadout, the slot is in metadata.
      target_type: "skinchanger_loadouts",
      target_id: user.id,
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
      // audit_logs.target_id is a uuid and entries have none: the target is the user's loadout, the slot is in metadata.
      target_type: "skinchanger_loadouts",
      target_id: user.id,
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

  // Play pages (5x5 / Fun / Pro): live servers from plugin heartbeats. See play.ts.
  const playModeParamSchema = z.enum(["5x5", "fun", "pro"]);
  const loadPlayServers = async () => {
    const [serversResult, snapshotsResult] = await Promise.all([
      db().schema("legacy_x").from("reconnect_servers").select("server_id,display_name,connect_address,gotv_address,current_map,current_mode,player_count,max_players,last_heartbeat_at").order("display_name").limit(200),
      db().schema("legacy_x").from("server_live_match_snapshots").select("server_id,state,map_name,round_number,score_t,score_ct,terrorist_players,counter_terrorist_players,reported_at").limit(200),
    ]);
    legacyXError(serversResult.error || snapshotsResult.error, "Unable to load servers");
    const snapshots = new Map(((snapshotsResult.data ?? []) as DbRow[]).map((row) => [textValue(row.server_id), row]));
    return ((serversResult.data ?? []) as DbRow[])
      .map((row) => mapPlayServer(row, snapshots.get(textValue(row.server_id)) ?? null))
      .filter((server): server is NonNullable<typeof server> => server !== null);
  };
  // Live kill feed for the top bar: kept in memory only (killfeed.ts), polled with a cursor.
  router.get("/public/killfeed", asyncRoute(async (req, res) => {
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after || undefined);
    res.setHeader("Cache-Control", "no-store");
    res.json(killFeed.since(after));
  }));
  router.get("/play/:mode/servers", asyncRoute(async (req, res) => {
    const mode: PlayMode = playModeParamSchema.parse(req.params.mode);
    const servers = sortPlayServers((await loadPlayServers()).filter((server) => server.mode === mode));
    const online = servers.filter((server) => server.status !== "offline");
    res.json({ mode, players: online.reduce((total, server) => total + server.players, 0), onlineServers: online.length, servers });
  }));
  router.get("/play/:mode/quick-join", asyncRoute(async (req, res) => {
    const mode: PlayMode = playModeParamSchema.parse(req.params.mode);
    const favouriteMaps = typeof req.query.maps === "string" ? req.query.maps.split(",").slice(0, 20) : [];
    const server = pickQuickJoin(await loadPlayServers(), mode, favouriteMaps);
    res.json({ mode, server, connectAddress: server?.connectAddress ?? null });
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

  // ---- Clans ----------------------------------------------------------------------------------------------------
  // Roles: leader (the owner), co-leader (manages requests, invitations and members), member. Staff can moderate any clan.
  const loadClanBasics = async (clanId: string) => {
    const { data, error } = await db().from("clans").select("id,name,tag,owner_id,join_mode,max_players,description,clan_members(count)").eq("id", clanId).maybeSingle();
    legacyXError(error, "Unable to load clan");
    if (!data) apiError(404, "Clan was not found", "clan_not_found");
    return data as DbRow;
  };
  const roleInClan = async (clanId: string, userId: string) => {
    const { data, error } = await db().from("clan_members").select("role").eq("clan_id", clanId).eq("user_id", userId).maybeSingle();
    legacyXError(error, "Unable to load membership");
    return clanRole(data?.role);
  };
  const requireClanManager = async (clanId: string, userId: string) => {
    const clan = await loadClanBasics(clanId);
    const role = await roleInClan(clanId, userId);
    if (!canManage(role)) apiError(403, "Clan leader or co-leader access is required", "clan_forbidden");
    return { clan, role };
  };
  const requireClanLeader = async (clanId: string, userId: string) => {
    const clan = await loadClanBasics(clanId);
    if (clan.owner_id !== userId) apiError(403, "Clan leader access is required", "clan_forbidden");
    return clan;
  };
  /** Owners and Managers moderate clans. An Admin can manage penalties but can neither change nor delete a clan. */
  const canModerateClans = async (userId: string) => {
    const { data } = await db().from("staff").select("role,permissions").eq("user_id", userId).eq("status", "active").maybeSingle();
    return Boolean(data && mayModerateClans(textValue(data.role), data.permissions));
  };
  const requireClanModerator = async (userId: string) => {
    if (!(await canModerateClans(userId))) apiError(403, "Owner or Manager access is required");
  };
  const logClan = async (clan: DbRow, actor: string | null, action: string, target: string | null = null, detail: string | null = null) => {
    const { error } = await db().from("clan_audit").insert({ clan_id: textValue(clan.id), clan_name: textValue(clan.name), actor_id: actor, action, target_id: target, detail: detail ? detail.slice(0, 300) : null });
    if (error) console.warn("[legacy-x-api] clan audit not saved", error.message);
  };
  const tellPlayer = async (userId: string, title: string, body: string, metadata: Record<string, unknown> = {}) => {
    const { error } = await db().from("notifications").insert({ user_id: userId, kind: "clan", title: title.slice(0, 120), body: body.slice(0, 500), metadata });
    if (error) console.warn("[legacy-x-api] clan notification not saved", error.message);
  };
  const clanManagerIds = async (clanId: string) => {
    const { data } = await db().from("clan_members").select("user_id").eq("clan_id", clanId).in("role", ["leader", "co-leader"]);
    return ((data ?? []) as DbRow[]).map((row) => textValue(row.user_id));
  };
  const usernameOf = async (userId: string) => {
    const { data } = await db().from("users").select("username").eq("id", userId).maybeSingle();
    return textValue(data?.username) || "A player";
  };
  /** Mapping of the join_clan / create_clan_paid failures that mean "no" for a reason the player can fix. */
  const clanRpcError = (error: { code?: string; message?: string } | null) => {
    if (!error) return;
    const message = String(error.message ?? "");
    if (/insufficient coins/i.test(message)) apiError(402, `A clan costs ${COIN_RULES.clanFee} LX`, "clan_no_coins");
    if (error.code === "23505") apiError(409, "That clan name or tag is already taken", "clan_name_taken");
    if (/already belongs/i.test(message)) apiError(409, "You already belong to a clan", "clan_already_member");
    if (/full/i.test(message)) apiError(409, "The clan is full", "clan_full");
    if (/not in the clan/i.test(message)) apiError(409, message, "clan_not_member");
    if (error.code === "P0001") apiError(409, message, "clan_rejected");
  };
  const waitAfterLeaving = async (userId: string) => {
    const { data } = await db().from("clan_audit").select("created_at").eq("actor_id", userId).eq("action", "left").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (leaveCooldownLeftMs(data?.created_at as string | undefined) > 0) apiError(409, "Wait a day after leaving a clan before joining another", "clan_cooldown");
  };

  router.get("/clans", optionalUserRoute(async (req, res) => {
    const input = z.object({ q: z.string().trim().max(40).optional(), sort: z.enum(["new", "name"]).default("new"), limit: z.coerce.number().int().min(1).max(60).default(24), offset: z.coerce.number().int().min(0).max(5000).default(0) }).parse(req.query);
    let query = db().from("clans").select("*,clan_members(count)");
    if (input.q) query = query.ilike("name", `%${escapeLike(input.q)}%`);
    query = input.sort === "name" ? query.order("name", { ascending: true }) : query.order("created_at", { ascending: false });
    const { data, error } = await query.range(input.offset, input.offset + input.limit - 1);
    legacyXError(error, "Unable to load clans");
    const looks = await clanLooksFor(db(), ((data ?? []) as DbRow[]).map((row) => textValue(row.id)));
    res.json(((data ?? []) as DbRow[]).map((row) => ({ ...mapClanCard(row), look: looks.get(textValue(row.id)) ?? null })));
  }));
  // Ranking: the total EXP of a clan's members, counted from real ranked results.
  router.get("/clans/leaderboard", optionalUserRoute(async (_req, res) => {
    const [clans, members] = await Promise.all([db().from("clans").select("id,number,name,tag,logo,thumbnail,region,max_players,join_mode"), db().from("clan_members").select("clan_id,user_id")]);
    legacyXError(clans.error || members.error, "Unable to load the clan ranking");
    const memberRows = (members.data ?? []) as DbRow[];
    const userIds = Array.from(new Set(memberRows.map((row) => textValue(row.user_id))));
    const progression = userIds.length ? await db().from("competitive_player_progression").select("user_id,current_exp,matches_completed,wins").in("user_id", userIds) : { data: [], error: null };
    legacyXError(progression.error, "Unable to load the clan ranking");
    const byUser = new Map(((progression.data ?? []) as DbRow[]).map((row) => [textValue(row.user_id), row]));
    const totals = new Map<string, { exp: number; matches: number; wins: number; members: number }>();
    for (const row of memberRows) {
      const total = totals.get(textValue(row.clan_id)) ?? { exp: 0, matches: 0, wins: 0, members: 0 };
      const stats = byUser.get(textValue(row.user_id));
      total.exp += numberValue(stats?.current_exp); total.matches += numberValue(stats?.matches_completed); total.wins += numberValue(stats?.wins); total.members += 1;
      totals.set(textValue(row.clan_id), total);
    }
    const looks = await clanLooksFor(db(), ((clans.data ?? []) as DbRow[]).map((clan) => textValue(clan.id)));
    const ranked = ((clans.data ?? []) as DbRow[])
      .map((clan) => ({ ...mapClanCard(clan, totals.get(textValue(clan.id))?.members ?? 0), look: looks.get(textValue(clan.id)) ?? null, totalExp: totals.get(textValue(clan.id))?.exp ?? 0, matches: totals.get(textValue(clan.id))?.matches ?? 0, wins: totals.get(textValue(clan.id))?.wins ?? 0 }))
      .filter((clan) => clan.currentPlayers > 0)
      .sort((a, b) => b.totalExp - a.totalExp || b.wins - a.wins || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((clan, index) => ({ ...clan, rank: index + 1 }));
    res.json({ clans: ranked });
  }));
  router.get("/clans/me", userRoute(async (_req, res, user) => {
    const { data, error } = await db().from("clan_members").select("role,clans(*)").eq("user_id", user.id).maybeSingle();
    legacyXError(error, "Unable to load current clan");
    const clan = firstRow(data?.clans);
    const [pending, invites] = await Promise.all([
      db().from("clan_join_requests").select("clan_id").eq("user_id", user.id),
      db().from("clan_invites").select("clan_id,created_at,clans(*)").eq("user_id", user.id).order("created_at", { ascending: false }),
    ]);
    legacyXError(pending.error || invites.error, "Unable to load join requests");
    res.json({
      membership: data && clan ? { role: textValue(data.role), clan: mapClanCard(clan, 0) } : null,
      pendingClanIds: ((pending.data ?? []) as DbRow[]).map((row) => textValue(row.clan_id)),
      invites: ((invites.data ?? []) as DbRow[]).flatMap((row) => { const invited = firstRow(row.clans); return invited ? [{ clan: mapClanCard(invited, 0), at: textValue(row.created_at) }] : []; }),
    });
  }));
  router.post("/clans", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const input = clanSchema.parse(req.body);
    await waitAfterLeaving(user.id);
    const { data, error } = await legacyXDb().rpc("create_clan_paid", { p_owner_id: user.id, p_name: input.name, p_tag: input.tag, p_region: input.region ?? "Mongolia", p_fee: COIN_RULES.clanFee, p_min_matches: 0, p_welcome: COIN_RULES.welcome });
    clanRpcError(error);
    legacyXError(error, "Unable to create clan");
    if (!data) apiError(500, "Clan was not created");
    const settings = await db().from("clans").update({ join_mode: input.joinMode, max_players: input.maxPlayers }).eq("id", String(data));
    if (settings.error) console.warn("[legacy-x-api] clan settings not saved", settings.error.message);
    await logClan({ id: String(data), name: input.name }, user.id, "created", null, `${input.joinMode}, ${input.maxPlayers} players`);
    res.status(201).json(await loadClanDetail(String(data), user.id));
  }));

  // Pictures. Anyone may look (an <img> cannot send a token); the leader and co-leaders may change them.
  for (const [kind, column] of [["logo", "logo"], ["banner", "thumbnail"]] as Array<[ClanArtKind, string]>) {
    router.get(`/clans/:clanId/${kind}`, asyncRoute(async (req, res) => {
      const clanId = await clanIdOf(req.params.clanId);
      const { data, error } = await db().from("clan_images").select("mime,data").eq("clan_id", clanId).eq("kind", kind).maybeSingle();
      legacyXError(error, "Unable to load the picture");
      if (!data) apiError(404, "No picture");
      const hex = String(data.data);
      res.set({ "Content-Type": String(data.mime), "Cache-Control": "public, max-age=31536000, immutable", "Content-Disposition": "inline" }).send(Buffer.from(hex.startsWith("\\x") ? hex.slice(2) : hex, "hex"));
    }));
    router.put(`/clans/:clanId/${kind}`, sensitiveMutationRateLimit, express.raw({ type: () => true, limit: CLAN_ART_LIMITS[kind].maxBytes + 1 }), userRoute(async (req, res, user) => {
      const clanId = await clanIdOf(req.params.clanId);
      const clan = await requireClanLeader(clanId, user.id);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const verdict = checkClanArt(kind, bytes);
      if (!verdict.ok) apiError(verdict.status, verdict.message);
      const saved = await db().from("clan_images").upsert({ clan_id: clanId, kind, mime: verdict.mime, data: `\\x${bytes.toString("hex")}`, updated_at: new Date().toISOString() });
      legacyXError(saved.error, "Unable to save the picture");
      const marker = await db().from("clans").update({ [column]: artMarker(Date.now()) }).eq("id", clanId);
      legacyXError(marker.error, "Unable to save the picture");
      await logClan(clan, user.id, kind);
      res.json(await loadClanDetail(clanId, user.id));
    }));
    router.delete(`/clans/:clanId/${kind}`, sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
      const clanId = await clanIdOf(req.params.clanId);
      const clan = await requireClanLeader(clanId, user.id);
      const removed = await db().from("clan_images").delete().eq("clan_id", clanId).eq("kind", kind);
      legacyXError(removed.error, "Unable to remove the picture");
      const marker = await db().from("clans").update({ [column]: kind === "logo" ? "" : null }).eq("id", clanId);
      legacyXError(marker.error, "Unable to remove the picture");
      await logClan(clan, user.id, kind, null, "removed");
      res.status(204).end();
    }));
  }

  router.get("/clans/:clanId", optionalUserRoute(async (req, res, user) => {
    res.json(await loadClanDetail(await clanIdOf(req.params.clanId), user?.id));
  }));
  router.get("/clans/:clanId/members", optionalUserRoute(async (req, res) => {
    const clanId = await clanIdOf(req.params.clanId);
    await loadClanBasics(clanId);
    const { data, error } = await db().from("clan_members").select("role,user_id,users(id,username,avatar)").eq("clan_id", clanId).order("created_at");
    legacyXError(error, "Unable to load clan members");
    const worn = await equippedCosmeticsFor(((data ?? []) as DbRow[]).map((member) => textValue(member.user_id)));
    res.json(((data ?? []) as DbRow[]).map((member) => ({ ...mapClanMember(member), ...lookOf(worn, textValue(member.user_id)) })));
  }));

  // Settings: description, who can join, player limit (the leader only).
  router.put("/clans/:clanId", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const input = z.object({ description: z.string().trim().max(200), joinMode: z.enum(["open", "request"]), maxPlayers: z.number().int().min(2).max(50) }).partial().strict().refine((value) => Object.keys(value).length > 0, "At least one clan field is required").parse(req.body);
    const clan = await requireClanLeader(clanId, user.id);
    if (input.maxPlayers !== undefined && input.maxPlayers < memberCount(clan)) apiError(409, "The clan already has more members than that", "clan_too_many_members");
    const { description, joinMode, maxPlayers } = input;
    const { error } = await db().from("clans").update({ ...(description !== undefined ? { description } : {}), ...(joinMode ? { join_mode: joinMode } : {}), ...(maxPlayers !== undefined ? { max_players: maxPlayers } : {}) }).eq("id", clanId);
    legacyXError(error, "Unable to update clan");
    await logClan(clan, user.id, "settings", null, [joinMode ? `join: ${joinMode}` : "", maxPlayers !== undefined ? `max: ${maxPlayers}` : "", description !== undefined ? "description" : ""].filter(Boolean).join(", "));
    res.json(await loadClanDetail(clanId, user.id));
  }));
  // A new name or tag costs coins and may be changed once a week (the leader only).
  router.put("/clans/:clanId/name", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const input = z.object({ name: clanSchema.shape.name.optional(), tag: clanSchema.shape.tag.optional() }).strict().refine((value) => value.name !== undefined || value.tag !== undefined, "A name or a tag is required").parse(req.body);
    const clan = await requireClanLeader(clanId, user.id);
    const { data: last } = await db().from("clan_audit").select("created_at").eq("clan_id", clanId).eq("action", "renamed").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (last && Date.now() - Date.parse(String(last.created_at)) < CLAN_LIMITS.renameCooldownDays * 86_400_000) apiError(409, "A clan can change its name or tag once a week", "clan_rename_cooldown");
    const next = { name: input.name ?? textValue(clan.name), tag: input.tag ?? textValue(clan.tag) };
    if (next.name === textValue(clan.name) && next.tag === textValue(clan.tag)) apiError(409, "Nothing changed", "clan_rejected");
    const ref = `clan-rename:${clanId}:${Date.now()}`;
    try {
      await applyWalletChange(legacyXDb(), { userId: user.id, amount: -COIN_RULES.clanRename, kind: "spend", reason: `Clan renamed: ${next.name} [${next.tag}]`, ref, actor: user.id });
    } catch (error) {
      if (error instanceof NotEnoughCoinsError) apiError(402, `Changing the name or tag costs ${COIN_RULES.clanRename} LX`, "clan_no_coins");
      throw error;
    }
    const { error } = await db().from("clans").update(next).eq("id", clanId);
    if (error) {
      await applyWalletChange(legacyXDb(), { userId: user.id, amount: COIN_RULES.clanRename, kind: "refund", reason: "Clan rename failed", ref: `${ref}:refund`, actor: user.id }).catch((refundError) => console.error("[legacy-x-api] clan rename refund failed", refundError));
      clanRpcError(error);
      legacyXError(error, "Unable to rename clan");
    }
    await logClan({ id: clanId, name: next.name }, user.id, "renamed", null, `${textValue(clan.name)} [${textValue(clan.tag)}] to ${next.name} [${next.tag}]`);
    res.json(await loadClanDetail(clanId, user.id));
  }));

  // Extra member slots cost coins; the leader buys them in steps, up to the cap.
  router.post("/clans/:clanId/slots", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const clan = await requireClanLeader(clanId, user.id);
    const current = Number(clan.max_players);
    if (current >= COIN_RULES.clanSlotCap) apiError(409, "The clan is already at the largest size", "clan_slots_cap");
    const next = Math.min(COIN_RULES.clanSlotCap, current + COIN_RULES.clanSlotStep);
    const ref = `clan-slots:${clanId}:${next}`;
    try {
      await applyWalletChange(legacyXDb(), { userId: user.id, amount: -COIN_RULES.clanSlotPrice, kind: "spend", reason: `Clan size ${current} to ${next}`, ref, actor: user.id });
    } catch (error) {
      if (error instanceof NotEnoughCoinsError) apiError(402, `More member slots cost ${COIN_RULES.clanSlotPrice} LX`, "clan_no_coins");
      throw error;
    }
    const { error } = await db().from("clans").update({ max_players: next }).eq("id", clanId).eq("max_players", current);
    if (error) {
      await applyWalletChange(legacyXDb(), { userId: user.id, amount: COIN_RULES.clanSlotPrice, kind: "refund", reason: "Clan size change failed", ref: `${ref}:refund`, actor: user.id }).catch((refundError) => console.error("[legacy-x-api] clan slots refund failed", refundError));
      legacyXError(error, "Unable to add member slots");
    }
    await logClan(clan, user.id, "settings", null, `max: ${next} (bought)`);
    res.json(await loadClanDetail(clanId, user.id));
  }));

  // Clan appearance (tag colour, tag glow, backdrop): the leader buys with coins, the clan owns it and wears one of each.
  // What a leader buys belongs to the player, not the clan: it stays theirs when the clan is deleted and goes with them to the next one.
  const lookView = async (clanId: string | null, userId: string) => {
    const [owned, worn] = await Promise.all([db().from("clan_look_owned_player").select("item_id").eq("user_id", userId), clanId ? db().from("clan_look_equipped").select("kind,item_id").eq("clan_id", clanId) : Promise.resolve({ data: [] as DbRow[], error: null })]);
    legacyXError(owned.error || worn.error, "Unable to load the clan's looks");
    const ownedIds = new Set(((owned.data ?? []) as DbRow[]).map((row) => textValue(row.item_id)));
    const wearing = Object.fromEntries(((worn.data ?? []) as DbRow[]).map((row) => [textValue(row.kind), textValue(row.item_id)]));
    return {
      items: CLAN_LOOK_ITEMS.map((item) => ({ ...item, owned: ownedIds.has(item.id) })),
      equipped: { tag_color: wearing.tag_color ?? null, tag_glow: wearing.tag_glow ?? null, backdrop: wearing.backdrop ?? null, page: wearing.page ?? null },
    };
  };
  // Buying needs no clan: a player can buy now and wear it once they lead one.
  const buyClanLook = async (userId: string, itemId: string) => {
    const item = clanLookItem(itemId);
    if (!item) apiError(404, "Item not found");
    const { data: have } = await db().from("clan_look_owned_player").select("item_id").eq("user_id", userId).eq("item_id", item.id).maybeSingle();
    if (have) apiError(409, "You already have this", "clan_look_owned");
    // The ref is per player and item, so a double click or a retry charges once.
    const ref = `clan-look:${userId}:${item.id}`;
    try {
      await applyWalletChange(legacyXDb(), { userId, amount: -item.price, kind: "spend", reason: `Clan look: ${item.name}`, ref, actor: userId });
    } catch (error) {
      if (error instanceof NotEnoughCoinsError) apiError(402, `This costs ${item.price} LX`, "clan_no_coins");
      throw error;
    }
    const { error } = await db().from("clan_look_owned_player").upsert({ user_id: userId, item_id: item.id }, { onConflict: "user_id,item_id", ignoreDuplicates: true });
    if (error) {
      await applyWalletChange(legacyXDb(), { userId, amount: item.price, kind: "refund", reason: "Clan look purchase failed", ref: `${ref}:refund`, actor: userId }).catch((refundError) => console.error("[legacy-x-api] clan look refund failed", refundError));
      legacyXError(error, "Unable to save the purchase");
    }
    return item;
  };
  router.get("/clan-looks", userRoute(async (_req, res, user) => {
    res.json(await lookView(null, user.id));
  }));
  router.post("/clan-looks/:itemId/buy", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    await buyClanLook(user.id, String(req.params.itemId));
    res.status(201).json(await lookView(null, user.id));
  }));
  router.get("/clans/:clanId/looks", userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    await requireClanLeader(clanId, user.id);
    res.json(await lookView(clanId, user.id));
  }));
  router.post("/clans/:clanId/looks/:itemId/buy", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const clan = await requireClanLeader(clanId, user.id);
    const item = await buyClanLook(user.id, String(req.params.itemId));
    await logClan(clan, user.id, "settings", null, `look: ${item.name} (bought)`);
    res.status(201).json(await lookView(clanId, user.id));
  }));
  // Wear one, or take it off with item: null.
  router.put("/clans/:clanId/looks/equip", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    await requireClanLeader(clanId, user.id);
    const input = z.object({ kind: z.enum(CLAN_LOOK_KINDS), item: z.string().regex(/^[a-z0-9-]{2,40}$/).nullable() }).strict().parse(req.body);
    if (input.item === null) {
      const { error } = await db().from("clan_look_equipped").delete().eq("clan_id", clanId).eq("kind", input.kind);
      legacyXError(error, "Unable to take it off");
    } else {
      const item = clanLookItem(input.item);
      if (!item || item.kind !== input.kind) apiError(404, "Item not found");
      const { data: have } = await db().from("clan_look_owned_player").select("item_id").eq("user_id", user.id).eq("item_id", item.id).maybeSingle();
      if (!have) apiError(403, "You do not have this yet", "clan_look_not_owned");
      const { error } = await db().from("clan_look_equipped").upsert({ clan_id: clanId, kind: input.kind, item_id: item.id, updated_at: new Date().toISOString() }, { onConflict: "clan_id,kind" });
      legacyXError(error, "Unable to wear it");
    }
    res.json(await lookView(clanId, user.id));
  }));

  // Player checks: Admin, Manager and Owner ask a player to run the checker program with a one-time code. Anyone can
  // download the program; only the code needs staff. The program sends back names and masked paths; staff decide.
  const requireCheckStaff = async (userId: string) => {
    const { data, error } = await db().from("staff").select("role").eq("user_id", userId).eq("status", "active").maybeSingle();
    legacyXError(error, "Unable to verify staff access");
    if (!data || !(CHECK_ROLES as readonly string[]).includes(textValue(data.role))) apiError(403, "Only an Admin, Manager or Owner can request a check", "check_forbidden");
    return textValue(data.role);
  };
  const checkRateLimit = rateLimit({ windowMs: 60_000, limit: process.env.NODE_ENV === "test" ? 1_000 : 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many attempts. Please retry shortly." } });
  const mapCheck = (row: DbRow, usernames: Map<string, string>, withReport = false) => {
    const pending = row.status === "pending" && Date.parse(textValue(row.expires_at)) <= Date.now();
    return {
      id: textValue(row.id),
      codeHint: textValue(row.code_hint),
      targetSteamId: textValue(row.target_steam_id),
      targetName: row.target_user_id ? usernames.get(textValue(row.target_user_id)) ?? null : null,
      targetAvatar: row.target_user_id ? usernames.get(`avatar:${textValue(row.target_user_id)}`) ?? null : null,
      requestedBy: usernames.get(textValue(row.requested_by)) ?? "Staff",
      status: pending ? "expired" : textValue(row.status),
      expiresAt: textValue(row.expires_at),
      createdAt: textValue(row.created_at),
      completedAt: row.completed_at ? textValue(row.completed_at) : null,
      checkerVersion: row.checker_version ? textValue(row.checker_version) : null,
      ...(row.report ? { summary: { detections: Number((row.report as DbRow).detections ?? 0), suspicions: Number((row.report as DbRow).suspicions ?? 0), matchesTarget: Boolean((row.report as DbRow).matchesTarget), bannedAccounts: (Array.isArray((row.report as DbRow).steamBans) ? ((row.report as DbRow).steamBans as DbRow[]) : []).filter((ban) => ban.vacBanned === true || Number(ban.gameBans ?? 0) > 0).length } } : {}),
      ...(withReport ? { report: row.report ?? null } : {}),
    };
  };
  const namesOf = async (ids: string[]) => {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    const names = new Map<string, string>();
    if (unique.length === 0) return names;
    const { data } = await db().from("users").select("id,username,avatar").in("id", unique);
    for (const row of (data ?? []) as DbRow[]) {
      names.set(textValue(row.id), textValue(row.username));
      if (row.avatar) names.set(`avatar:${textValue(row.id)}`, textValue(row.avatar));
    }
    return names;
  };

  router.post("/checks", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    await requireCheckStaff(user.id);
    const { steamId } = createCheckSchema.parse(req.body);
    const { data: open } = await db().from("player_checks").select("id").eq("target_steam_id", steamId).eq("status", "pending").gt("expires_at", new Date().toISOString()).maybeSingle();
    if (open) apiError(409, "This player already has an open check", "check_open");
    const { data: target } = await db().from("users").select("id").eq("steam_id", steamId).maybeSingle();
    const code = generateCheckCode();
    const normalized = normalizeCheckCode(code) ?? "";
    const expiresAt = new Date(Date.now() + CHECK_CODE_MINUTES * 60_000).toISOString();
    const { data, error } = await db().from("player_checks").insert({ code_hash: hashCheckCode(normalized), code_hint: normalized.slice(-4), target_steam_id: steamId, target_user_id: target ? textValue(target.id) : null, requested_by: user.id, expires_at: expiresAt }).select("id").single();
    legacyXError(error, "Unable to create the check");
    await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "check.create", target_type: "player_checks", target_id: textValue(data?.id), metadata: { steamId } });
    // The code is shown here once; only its hash is kept.
    const downloadAvailable = (await checkerBase()) !== null;
    res.status(201).json({ id: textValue(data?.id), code, expiresAt, steamId, downloadAvailable, downloadPath: downloadAvailable ? `/api/v1/checks/code/${code}/download` : null });
  }));
  router.get("/checks", userRoute(async (_req, res, user) => {
    await requireCheckStaff(user.id);
    // Finished checks do not stay for ever.
    await db().from("player_checks").delete().lt("created_at", new Date(Date.now() - CHECK_RETENTION_DAYS * 86_400_000).toISOString());
    const { data, error } = await db().from("player_checks").select("id,code_hint,target_steam_id,target_user_id,requested_by,status,expires_at,completed_at,checker_version,report,created_at").order("created_at", { ascending: false }).limit(50);
    legacyXError(error, "Unable to load the checks");
    const rows = (data ?? []) as DbRow[];
    const names = await namesOf(rows.flatMap((row) => [textValue(row.requested_by), row.target_user_id ? textValue(row.target_user_id) : ""]));
    res.json(rows.map((row) => mapCheck(row, names)));
  }));
  router.get("/checks/:id", userRoute(async (req, res, user) => {
    await requireCheckStaff(user.id);
    const id = z.string().uuid().parse(req.params.id);
    const { data, error } = await db().from("player_checks").select("*").eq("id", id).maybeSingle();
    legacyXError(error, "Unable to load the check");
    if (!data) apiError(404, "Check not found");
    const names = await namesOf([textValue(data.requested_by), data.target_user_id ? textValue(data.target_user_id) : ""]);
    res.json(mapCheck(data as DbRow, names, true));
  }));
  router.delete("/checks/:id", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const role = await requireCheckStaff(user.id);
    const id = z.string().uuid().parse(req.params.id);
    const { data } = await db().from("player_checks").select("requested_by,status").eq("id", id).maybeSingle();
    if (!data) apiError(404, "Check not found");
    if (textValue(data.requested_by) !== user.id && role === "ADMIN") apiError(403, "An Admin can only cancel their own checks", "check_forbidden");
    const { error } = await db().from("player_checks").delete().eq("id", id);
    legacyXError(error, "Unable to remove the check");
    await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "check.delete", target_type: "player_checks", target_id: id, metadata: {} });
    res.status(204).end();
  }));

  // For the checker program: it asks who wants the check, shows that to the player, then sends the report. No login: the code is the key.
  router.get("/checks/code/:code", checkRateLimit, asyncRoute(async (req, res) => {
    const normalized = normalizeCheckCode(String(req.params.code));
    if (!normalized) apiError(404, "That code is not valid", "check_code_invalid");
    const { data } = await db().from("player_checks").select("requested_by,status,expires_at").eq("code_hash", hashCheckCode(normalized)).maybeSingle();
    if (!data || data.status !== "pending" || Date.parse(textValue(data.expires_at)) <= Date.now()) apiError(404, "That code is not valid or has expired", "check_code_invalid");
    const names = await namesOf([textValue(data.requested_by)]);
    res.json({ requestedBy: names.get(textValue(data.requested_by)) ?? "Staff", expiresAt: textValue(data.expires_at) });
  }));
  // The personal download: the checker with this check's code inside (check.json), so the player has nothing to type.
  router.get("/checks/code/:code/download", checkRateLimit, asyncRoute(async (req, res) => {
    const normalized = normalizeCheckCode(String(req.params.code));
    if (!normalized) apiError(404, "That code is not valid", "check_code_invalid");
    const { data } = await db().from("player_checks").select("id,requested_by,status,expires_at,download_count,code_hint").eq("code_hash", hashCheckCode(normalized)).maybeSingle();
    if (!data || data.status !== "pending" || Date.parse(textValue(data.expires_at)) <= Date.now()) apiError(404, "That code is not valid or has expired", "check_code_invalid");
    const base = await checkerBase();
    if (!base) apiError(404, "The checker is not available for download here", "check_download_unavailable");
    const used = Number(data.download_count ?? 0);
    if (used >= CHECK_MAX_DOWNLOADS) apiError(409, "This download was already used", "check_download_used");
    // Count it before sending, and only if nobody else counted at the same moment.
    const { data: counted, error } = await db().from("player_checks").update({ download_count: used + 1 }).eq("id", textValue(data.id)).eq("download_count", used).select("id");
    legacyXError(error, "Unable to prepare the download");
    if (!counted || counted.length === 0) apiError(409, "Try the download again", "check_download_busy");
    const names = await namesOf([textValue(data.requested_by)]);
    const code = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
    const sources = [...base, { name: "check.json", data: Buffer.from(JSON.stringify({ code, requestedBy: names.get(textValue(data.requested_by)) ?? "Staff" }, null, 2)) }];
    res.set({ "Content-Type": "application/zip", "Content-Length": String(zipLength(sources)), "Content-Disposition": `attachment; filename="LegacyX-Checker-${textValue(data.code_hint)}.zip"`, "Cache-Control": "no-store" });
    for await (const chunk of zipChunks(sources)) {
      if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", () => resolve()));
    }
    res.end();
  }));
  router.post("/checks/code/:code/report", checkRateLimit, asyncRoute(async (req, res) => {
    const normalized = normalizeCheckCode(String(req.params.code));
    if (!normalized) apiError(404, "That code is not valid", "check_code_invalid");
    const report = checkReportSchema.parse(req.body);
    const { data } = await db().from("player_checks").select("id,target_steam_id,status,expires_at").eq("code_hash", hashCheckCode(normalized)).maybeSingle();
    if (!data || data.status !== "pending" || Date.parse(textValue(data.expires_at)) <= Date.now()) apiError(404, "That code is not valid or has expired", "check_code_invalid");
    // What Steam says about the accounts on the PC and the player who was asked (names, VAC and game bans). Extra, never required.
    const steamBans = await fetchSteamBans([textValue(data.target_steam_id), ...report.steamIds, ...(report.steamAccounts ?? []).map((account) => account.steamId)]);
    // Only the first report counts: the status moves in the same statement that is checked.
    const { data: updated, error } = await db().from("player_checks").update({ status: "completed", completed_at: new Date().toISOString(), checker_version: report.checkerVersion, report: summarizeReport(report, textValue(data.target_steam_id), steamBans) }).eq("id", textValue(data.id)).eq("status", "pending").select("id");
    legacyXError(error, "Unable to save the report");
    if (!updated || updated.length === 0) apiError(409, "This code was already used", "check_code_used");
    res.status(201).json({ received: true });
  }));

  // Joining: open clans take you at once, the others get a request. One clan at a time, at most three open requests.
  router.post("/clans/:clanId/join", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const clan = await loadClanBasics(clanId);
    await waitAfterLeaving(user.id);
    if (clan.join_mode === "request") {
      const { data: already } = await db().from("clan_members").select("clan_id").eq("user_id", user.id).maybeSingle();
      if (already) apiError(409, "You already belong to a clan", "clan_already_member");
      const { data: open } = await db().from("clan_join_requests").select("clan_id").eq("user_id", user.id);
      const waiting = (open ?? []) as DbRow[];
      if (!waiting.some((row) => row.clan_id === clanId) && waiting.length >= CLAN_LIMITS.pendingRequests) apiError(409, `You can have ${CLAN_LIMITS.pendingRequests} open requests at a time`, "clan_requests_limit");
      const { error } = await db().from("clan_join_requests").upsert({ clan_id: clanId, user_id: user.id }, { onConflict: "clan_id,user_id", ignoreDuplicates: true });
      legacyXError(error, "Unable to send the request");
      if (!waiting.some((row) => row.clan_id === clanId)) {
        await logClan(clan, user.id, "requested");
        const who = await usernameOf(user.id);
        for (const managerId of await clanManagerIds(clanId)) await tellPlayer(managerId, "New clan request", `${who} asked to join ${textValue(clan.name)}.`, { clanId, kind: "request" });
      }
      res.status(202).json({ status: "requested" });
      return;
    }
    const { error } = await db().rpc("join_clan", { p_user_id: user.id, p_clan_id: clanId });
    clanRpcError(error);
    legacyXError(error, "Unable to join clan");
    await db().from("clan_join_requests").delete().eq("user_id", user.id);
    await db().from("clan_invites").delete().eq("user_id", user.id);
    await logClan(clan, user.id, "joined");
    res.json({ status: "joined" });
  }));
  router.delete("/clans/:clanId/join-request", userRoute(async (req, res, user) => {
    const { error } = await db().from("clan_join_requests").delete().eq("clan_id", await clanIdOf(req.params.clanId)).eq("user_id", user.id);
    legacyXError(error, "Unable to withdraw the request");
    res.status(204).end();
  }));
  router.get("/clans/:clanId/requests", userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    await requireClanManager(clanId, user.id);
    const { data, error } = await db().from("clan_join_requests").select("user_id,created_at,users(id,username,avatar)").eq("clan_id", clanId).order("created_at");
    legacyXError(error, "Unable to load requests");
    res.json(((data ?? []) as DbRow[]).map((row) => { const player = firstRow(row.users) ?? {}; return { id: textValue(row.user_id), name: textValue(player.username), avatar: textValue(player.avatar), at: textValue(row.created_at) }; }));
  }));
  router.post("/clans/:clanId/requests/:userId/accept", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const applicant = userIdSchema.parse(req.params.userId);
    const { clan } = await requireClanManager(clanId, user.id);
    const { data: request, error: lookupError } = await db().from("clan_join_requests").select("user_id").eq("clan_id", clanId).eq("user_id", applicant).maybeSingle();
    legacyXError(lookupError, "Unable to load the request");
    if (!request) apiError(404, "There is no such request", "clan_not_found");
    const { error } = await db().rpc("join_clan", { p_user_id: applicant, p_clan_id: clanId });
    clanRpcError(error);
    legacyXError(error, "Unable to accept the request");
    await db().from("clan_join_requests").delete().eq("user_id", applicant);
    await db().from("clan_invites").delete().eq("user_id", applicant);
    await logClan(clan, user.id, "accepted", applicant);
    await tellPlayer(applicant, "Clan request accepted", `You are now in ${textValue(clan.name)}.`, { clanId, kind: "accepted" });
    res.status(204).end();
  }));
  router.delete("/clans/:clanId/requests/:userId", userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const applicant = userIdSchema.parse(req.params.userId);
    const { clan } = await requireClanManager(clanId, user.id);
    const { error } = await db().from("clan_join_requests").delete().eq("clan_id", clanId).eq("user_id", applicant);
    legacyXError(error, "Unable to decline the request");
    await logClan(clan, user.id, "declined", applicant);
    await tellPlayer(applicant, "Clan request declined", `${textValue(clan.name)} did not accept your request.`, { clanId, kind: "declined" });
    res.status(204).end();
  }));

  // Invitations: a leader or co-leader invites a player by name; the player accepts or declines.
  router.post("/clans/:clanId/invites", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const input = z.object({ username: z.string().trim().min(1).max(PROFILE_NAME_MAX) }).strict().parse(req.body);
    const { clan } = await requireClanManager(clanId, user.id);
    const target = await resolveUserId(input.username, user).catch(() => null);
    if (!target) apiError(404, "No player has that name", "clan_player_not_found");
    if (target === user.id) apiError(409, "You are already in the clan", "clan_already_member");
    const { data: member } = await db().from("clan_members").select("clan_id").eq("user_id", target).maybeSingle();
    if (member) apiError(409, "That player already belongs to a clan", "clan_already_member");
    const { data: waiting } = await db().from("clan_invites").select("user_id").eq("clan_id", clanId);
    const invited = (waiting ?? []) as DbRow[];
    if (!invited.some((row) => row.user_id === target) && invited.length >= CLAN_LIMITS.pendingInvites) apiError(409, "Too many invitations are waiting", "clan_invites_limit");
    const { error } = await db().from("clan_invites").upsert({ clan_id: clanId, user_id: target, invited_by: user.id }, { onConflict: "clan_id,user_id", ignoreDuplicates: true });
    legacyXError(error, "Unable to send the invitation");
    if (!invited.some((row) => row.user_id === target)) {
      await logClan(clan, user.id, "invited", target);
      await tellPlayer(target, "Clan invitation", `${textValue(clan.name)} invited you to join.`, { clanId, kind: "invite" });
    }
    res.status(201).json({ status: "invited" });
  }));
  router.get("/clans/:clanId/invites", userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    await requireClanManager(clanId, user.id);
    const { data, error } = await db().from("clan_invites").select("user_id,created_at,users:users!clan_invites_user_id_fkey(id,username,avatar)").eq("clan_id", clanId).order("created_at");
    legacyXError(error, "Unable to load invitations");
    res.json(((data ?? []) as DbRow[]).map((row) => { const player = firstRow(row.users) ?? {}; return { id: textValue(row.user_id), name: textValue(player.username), avatar: textValue(player.avatar), at: textValue(row.created_at) }; }));
  }));
  router.delete("/clans/:clanId/invites/:userId", userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const target = userIdSchema.parse(req.params.userId);
    const { clan } = await requireClanManager(clanId, user.id);
    const { error } = await db().from("clan_invites").delete().eq("clan_id", clanId).eq("user_id", target);
    legacyXError(error, "Unable to withdraw the invitation");
    await logClan(clan, user.id, "invite_revoked", target);
    res.status(204).end();
  }));
  router.post("/clans/:clanId/invite/accept", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const clan = await loadClanBasics(clanId);
    const { data: invite } = await db().from("clan_invites").select("clan_id").eq("clan_id", clanId).eq("user_id", user.id).maybeSingle();
    if (!invite) apiError(404, "There is no such invitation", "clan_not_found");
    await waitAfterLeaving(user.id);
    const { error } = await db().rpc("join_clan", { p_user_id: user.id, p_clan_id: clanId });
    clanRpcError(error);
    legacyXError(error, "Unable to join clan");
    await db().from("clan_invites").delete().eq("user_id", user.id);
    await db().from("clan_join_requests").delete().eq("user_id", user.id);
    await logClan(clan, user.id, "joined", null, "invitation");
    res.json({ status: "joined" });
  }));
  router.delete("/clans/:clanId/invite", userRoute(async (req, res, user) => {
    const { error } = await db().from("clan_invites").delete().eq("clan_id", await clanIdOf(req.params.clanId)).eq("user_id", user.id);
    legacyXError(error, "Unable to decline the invitation");
    res.status(204).end();
  }));

  // Leaving, removing members, roles, handing the clan over, deleting.
  router.post("/clans/:clanId/leave", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const clan = await loadClanBasics(clanId);
    if (clan.owner_id === user.id) apiError(409, "Hand the clan to someone else or delete it before leaving", "clan_leader_cannot_leave");
    const { error } = await db().from("clan_members").delete().eq("clan_id", clanId).eq("user_id", user.id);
    legacyXError(error, "Unable to leave clan");
    await logClan(clan, user.id, "left");
    res.status(204).end();
  }));
  router.delete("/clans/:clanId/members/:userId", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const target = userIdSchema.parse(req.params.userId);
    const { clan, role } = await requireClanManager(clanId, user.id);
    if (target === user.id) apiError(409, "Use Leave to go yourself", "clan_rejected");
    if (!canRemove(role, await roleInClan(clanId, target))) apiError(403, "You cannot remove that member", "clan_forbidden");
    const { error } = await db().from("clan_members").delete().eq("clan_id", clanId).eq("user_id", target);
    legacyXError(error, "Unable to remove member");
    await logClan(clan, user.id, "kicked", target);
    await tellPlayer(target, "Removed from a clan", `You were removed from ${textValue(clan.name)}.`, { clanId, kind: "kicked" });
    res.status(204).end();
  }));
  router.put("/clans/:clanId/members/:userId/role", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const target = userIdSchema.parse(req.params.userId);
    const input = z.object({ role: z.enum(["co-leader", "member"]) }).strict().parse(req.body);
    const clan = await requireClanLeader(clanId, user.id);
    if (target === user.id) apiError(409, "The leader keeps the leader role", "clan_rejected");
    if (!(await roleInClan(clanId, target))) apiError(404, "That player is not in the clan", "clan_not_member");
    const { error } = await db().from("clan_members").update({ role: input.role, updated_at: new Date().toISOString() }).eq("clan_id", clanId).eq("user_id", target);
    legacyXError(error, "Unable to change the role");
    await logClan(clan, user.id, input.role === "co-leader" ? "promoted" : "demoted", target);
    res.status(204).end();
  }));
  router.post("/clans/:clanId/transfer", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const input = z.object({ userId: z.string().uuid() }).strict().parse(req.body);
    const clan = await requireClanLeader(clanId, user.id);
    if (input.userId === user.id) apiError(409, "You already lead the clan", "clan_rejected");
    const { error } = await db().rpc("transfer_clan_leader", { p_clan_id: clanId, p_from: user.id, p_to: input.userId });
    clanRpcError(error);
    legacyXError(error, "Unable to hand over the clan");
    await logClan(clan, user.id, "transferred", input.userId);
    await tellPlayer(input.userId, "You lead a clan now", `${textValue(clan.name)} was handed over to you.`, { clanId, kind: "transferred" });
    res.status(204).end();
  }));
  router.delete("/clans/:clanId", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    const clan = await loadClanBasics(clanId);
    const { error } = await db().rpc("delete_owned_clan", { p_owner_id: user.id, p_clan_id: clanId });
    if (error?.code === "P0002") apiError(403, "Clan leader access is required", "clan_forbidden");
    legacyXError(error, "Unable to delete clan");
    await logClan(clan, user.id, "deleted");
    res.status(204).end();
  }));

  // What happened in the clan lately (leader and co-leaders).
  router.get("/clans/:clanId/activity", userRoute(async (req, res, user) => {
    const clanId = await clanIdOf(req.params.clanId);
    await requireClanManager(clanId, user.id);
    const { data, error } = await db().from("clan_audit").select("id,actor_id,action,target_id,detail,created_at").eq("clan_id", clanId).order("created_at", { ascending: false }).limit(CLAN_LIMITS.activityLimit);
    legacyXError(error, "Unable to load the activity");
    const rows = (data ?? []) as DbRow[];
    const ids = Array.from(new Set(rows.flatMap((row) => [textValue(row.actor_id), textValue(row.target_id)]).filter(Boolean)));
    const people = ids.length ? await db().from("users").select("id,username").in("id", ids) : { data: [], error: null };
    const names = new Map(((people.data ?? []) as DbRow[]).map((row) => [textValue(row.id), textValue(row.username)]));
    res.json(rows.map((row) => {
      const actor = names.get(textValue(row.actor_id)) ?? "Someone";
      const target = row.target_id ? names.get(textValue(row.target_id)) ?? "a player" : null;
      const subject = target && ["kicked", "promoted", "demoted", "transferred", "accepted", "declined", "invited", "invite_revoked"].includes(textValue(row.action)) ? target : actor;
      const by = subject !== actor ? ` · by ${actor}` : "";
      return { id: textValue(row.id), text: `${subject} ${describeClanAction(textValue(row.action), row.detail == null ? null : textValue(row.detail))}${by}`, at: textValue(row.created_at) };
    }));
  }));

  // Staff moderation: Owners and Managers can fix or remove a clan that breaks the rules.
  router.delete("/staff/clans/:clanId", userRoute(async (req, res, user) => {
    await requireClanModerator(user.id);
    const clanId = await clanIdOf(req.params.clanId);
    const clan = await loadClanBasics(clanId);
    const { error } = await db().from("clans").delete().eq("id", clanId);
    legacyXError(error, "Unable to delete clan");
    await logClan(clan, user.id, "moderated", null, "clan deleted by staff");
    res.status(204).end();
  }));
  router.delete("/staff/clans/:clanId/art/:kind", userRoute(async (req, res, user) => {
    await requireClanModerator(user.id);
    const clanId = await clanIdOf(req.params.clanId);
    const kind = z.enum(["logo", "banner"]).parse(req.params.kind);
    const clan = await loadClanBasics(clanId);
    const removed = await db().from("clan_images").delete().eq("clan_id", clanId).eq("kind", kind);
    legacyXError(removed.error, "Unable to remove the picture");
    const marker = await db().from("clans").update({ [kind === "logo" ? "logo" : "thumbnail"]: kind === "logo" ? "" : null }).eq("id", clanId);
    legacyXError(marker.error, "Unable to remove the picture");
    await logClan(clan, user.id, "moderated", null, `${kind} removed by staff`);
    res.status(204).end();
  }));
  router.delete("/staff/clans/:clanId/description", userRoute(async (req, res, user) => {
    await requireClanModerator(user.id);
    const clanId = await clanIdOf(req.params.clanId);
    const clan = await loadClanBasics(clanId);
    const { error } = await db().from("clans").update({ description: null }).eq("id", clanId);
    legacyXError(error, "Unable to clear the description");
    await logClan(clan, user.id, "moderated", null, "description cleared by staff");
    res.status(204).end();
  }));
  router.put("/staff/clans/:clanId/name", userRoute(async (req, res, user) => {
    await requireClanModerator(user.id);
    const clanId = await clanIdOf(req.params.clanId);
    const input = z.object({ name: clanSchema.shape.name, tag: clanSchema.shape.tag }).strict().parse(req.body);
    const clan = await loadClanBasics(clanId);
    const { error } = await db().from("clans").update(input).eq("id", clanId);
    clanRpcError(error);
    legacyXError(error, "Unable to rename clan");
    await logClan({ id: clanId, name: input.name }, user.id, "moderated", null, `renamed by staff: ${textValue(clan.name)} [${textValue(clan.tag)}] to ${input.name} [${input.tag}]`);
    res.status(204).end();
  }));
  // Tournaments: player-based registration (solo or as a team). See tournaments.ts for the contract.
  const tournamentIdSchema = z.string().uuid();
  const loadTournamentRow = async (tournamentId: string) => {
    const { data, error } = await db().from("tournaments").select("*").eq("id", tournamentId).maybeSingle();
    legacyXError(error, "Unable to load tournament");
    if (!data) apiError(404, "Tournament was not found");
    return data as DbRow;
  };
  const loadTournamentDetail = async (tournamentId: string, viewer: LegacyUser | null) => {
    let tournament = await loadTournamentRow(tournamentId);
    // Solo players are balanced into teams once registration has closed (idempotent).
    if (tournamentPhase(tournament) === "upcoming") {
      const { error } = await db().rpc("balance_tournament_solo_players", { p_tournament_id: tournamentId });
      legacyXError(error, "Unable to balance solo players");
    }
    const [teamsResult, registrationsResult, matchesResult] = await Promise.all([
      db().from("tournament_teams").select("id,name,captain_user_id,seed,auto_balanced").eq("tournament_id", tournamentId),
      db().from("tournament_registrations").select("user_id,team_id,mode,checked_in_at,created_at,users(username,steam_id,avatar)").eq("tournament_id", tournamentId).order("created_at"),
      db().from("tournament_matches").select("*,maps(id,label),reconnect_servers(server_id,display_name,connect_address)").eq("tournament_id", tournamentId).order("bracket_order"),
    ]);
    legacyXError(teamsResult.error || registrationsResult.error || matchesResult.error, "Unable to load tournament");
    const teamRows = (teamsResult.data ?? []) as DbRow[];
    const registrations = (registrationsResult.data ?? []) as DbRow[];
    const { teams, soloPlayers } = groupTeams(teamRows, registrations);
    const teamNames = new Map(teams.map((team) => [team.id, team.name]));
    const matches = ((matchesResult.data ?? []) as DbRow[]).map((match) => mapTournamentPlayerMatch(match, teamNames));
    const own = viewer ? registrations.find((registration) => registration.user_id === viewer.id) : undefined;
    const ownTeamId = own ? textValue(own.team_id) || null : null;
    const winnerId = textValue(tournament.winner_team_id);
    return {
      ...mapTournamentSummary(tournament, registrations.length),
      checkInOpen: checkInOpen(tournament),
      winner: winnerId ? { id: winnerId, name: teamNames.get(winnerId) ?? "Winner" } : null,
      teams,
      soloPlayers,
      matches,
      bracket: bracketRounds(matches),
      me: viewer ? (own ? {
        registered: true,
        mode: own.mode === "team" ? "team" as const : "solo" as const,
        teamId: ownTeamId,
        isCaptain: Boolean(ownTeamId && teams.find((team) => team.id === ownTeamId)?.captainUserId === viewer.id),
        checkedInAt: timestampValue(own.checked_in_at) || null,
        nextMatch: nextMatchFor(ownTeamId, matches),
      } : { registered: false, mode: null, teamId: null, isCaptain: false, checkedInAt: null, nextMatch: null }) : null,
    };
  };
  const requireOpenRegistration = (tournament: DbRow) => {
    if (tournamentPhase(tournament) !== "registration") apiError(409, "Registration is closed");
  };
  const requireCapacity = async (tournament: DbRow) => {
    const maxPlayers = typeof tournament.max_players === "number" ? tournament.max_players : null;
    if (!maxPlayers) return;
    const { count, error } = await db().from("tournament_registrations").select("id", { count: "exact", head: true }).eq("tournament_id", tournament.id);
    legacyXError(error, "Unable to count tournament registrations");
    if ((count ?? 0) >= maxPlayers) apiError(409, "The tournament is full");
  };

  router.get("/tournaments", asyncRoute(async (_req, res) => {
    const { data, error } = await db().from("tournaments").select("*").order("starts_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(50);
    legacyXError(error, "Unable to load tournaments");
    const rows = (data ?? []) as DbRow[];
    const open = rows.filter((row) => row.status !== "completed").sort((a, b) => (Date.parse(textValue(a.starts_at)) || Infinity) - (Date.parse(textValue(b.starts_at)) || Infinity));
    const current = open.find((row) => row.status === "active") ?? open[0] ?? null;
    const past = rows.filter((row) => row.status === "completed");
    const winnerIds = past.map((row) => textValue(row.winner_team_id)).filter(Boolean);
    const [countResult, winnersResult] = await Promise.all([
      current ? db().from("tournament_registrations").select("id", { count: "exact", head: true }).eq("tournament_id", current.id) : Promise.resolve({ count: 0, error: null }),
      winnerIds.length ? db().from("tournament_teams").select("id,name").in("id", winnerIds) : Promise.resolve({ data: [], error: null }),
    ]);
    legacyXError(countResult.error || winnersResult.error, "Unable to load tournaments");
    const winners = new Map(((winnersResult.data ?? []) as DbRow[]).map((team) => [textValue(team.id), textValue(team.name)]));
    res.json({
      current: current ? mapTournamentSummary(current, countResult.count ?? 0) : null,
      past: past.map((row) => ({ id: textValue(row.id), name: textValue(row.name) || textValue(row.season) || "Tournament", startsAt: timestampValue(row.starts_at) || null, winner: winners.get(textValue(row.winner_team_id)) ?? null })),
    });
  }));
  router.get("/tournaments/:tournamentId", optionalUserRoute(async (req, res, user) => {
    res.json(await loadTournamentDetail(tournamentIdSchema.parse(req.params.tournamentId), user));
  }));
  router.post("/tournaments/:tournamentId/register", userRoute(async (req, res, user) => {
    const tournamentId = tournamentIdSchema.parse(req.params.tournamentId);
    const input = z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("solo") }),
      z.object({ mode: z.literal("team"), teamName: z.string().trim().min(2).max(32) }),
      z.object({ mode: z.literal("join"), teamId: z.string().uuid() }),
    ]).parse(req.body);
    const tournament = await loadTournamentRow(tournamentId);
    requireOpenRegistration(tournament);
    await requireCapacity(tournament);
    const { data: existing, error: existingError } = await db().from("tournament_registrations").select("id").eq("tournament_id", tournamentId).eq("user_id", user.id).maybeSingle();
    legacyXError(existingError, "Unable to check registration");
    if (existing) apiError(409, "You are already registered");
    if (input.mode === "solo") {
      const { error } = await db().from("tournament_registrations").insert({ tournament_id: tournamentId, user_id: user.id, mode: "solo" });
      legacyXError(error, "Unable to register for tournament");
    } else if (input.mode === "team") {
      const { data: team, error: teamError } = await db().from("tournament_teams").insert({ tournament_id: tournamentId, name: input.teamName, captain_user_id: user.id }).select("id").single();
      if (teamError?.code === "23505") apiError(409, "That team name is taken");
      legacyXError(teamError, "Unable to create team");
      const { error } = await db().from("tournament_registrations").insert({ tournament_id: tournamentId, user_id: user.id, mode: "team", team_id: (team as DbRow).id });
      if (error) await db().from("tournament_teams").delete().eq("id", (team as DbRow).id);
      legacyXError(error, "Unable to register team");
    } else {
      const { data: team, error: teamError } = await db().from("tournament_teams").select("id,auto_balanced").eq("id", input.teamId).eq("tournament_id", tournamentId).maybeSingle();
      legacyXError(teamError, "Unable to load team");
      if (!team || (team as DbRow).auto_balanced) apiError(404, "Team was not found");
      const { count, error: countError } = await db().from("tournament_registrations").select("id", { count: "exact", head: true }).eq("team_id", input.teamId);
      legacyXError(countError, "Unable to count team members");
      if ((count ?? 0) >= (typeof tournament.team_size === "number" ? tournament.team_size : 5)) apiError(409, "That team is full");
      const { error } = await db().from("tournament_registrations").insert({ tournament_id: tournamentId, user_id: user.id, mode: "team", team_id: input.teamId });
      legacyXError(error, "Unable to join team");
    }
    res.status(201).json(await loadTournamentDetail(tournamentId, user));
  }));
  router.delete("/tournaments/:tournamentId/register", userRoute(async (req, res, user) => {
    const tournamentId = tournamentIdSchema.parse(req.params.tournamentId);
    requireOpenRegistration(await loadTournamentRow(tournamentId));
    const { data: own, error } = await db().from("tournament_registrations").select("id,team_id,mode").eq("tournament_id", tournamentId).eq("user_id", user.id).maybeSingle();
    legacyXError(error, "Unable to load registration");
    if (!own) { res.status(204).end(); return; }
    const teamId = textValue((own as DbRow).team_id);
    const { data: team } = teamId ? await db().from("tournament_teams").select("captain_user_id").eq("id", teamId).maybeSingle() : { data: null };
    if (team && (team as DbRow).captain_user_id === user.id) {
      // The captain leaving disbands the team: its members' registrations go with it.
      const { error: membersError } = await db().from("tournament_registrations").delete().eq("team_id", teamId);
      legacyXError(membersError, "Unable to leave tournament");
      const { error: teamError } = await db().from("tournament_teams").delete().eq("id", teamId);
      legacyXError(teamError, "Unable to leave tournament");
    } else {
      const { error: leaveError } = await db().from("tournament_registrations").delete().eq("id", (own as DbRow).id);
      legacyXError(leaveError, "Unable to leave tournament");
    }
    res.status(204).end();
  }));
  router.post("/tournaments/:tournamentId/check-in", userRoute(async (req, res, user) => {
    const tournamentId = tournamentIdSchema.parse(req.params.tournamentId);
    const tournament = await loadTournamentRow(tournamentId);
    if (!checkInOpen(tournament)) apiError(409, "Check-in is not open");
    const { data, error } = await db().from("tournament_registrations").update({ checked_in_at: new Date().toISOString() }).eq("tournament_id", tournamentId).eq("user_id", user.id).is("checked_in_at", null).select("id");
    legacyXError(error, "Unable to check in");
    if (!(data ?? []).length) {
      const { data: own } = await db().from("tournament_registrations").select("id").eq("tournament_id", tournamentId).eq("user_id", user.id).maybeSingle();
      if (!own) apiError(403, "You are not registered for this tournament");
    }
    res.json(await loadTournamentDetail(tournamentId, user));
  }));

  router.get("/moderation/penalties", asyncRoute(async (req, res) => {
    const filters = z.object({ type: penaltyTypeSchema.optional(), query: z.string().trim().min(1).max(64).optional() }).parse(req.query);
    let query = db().from("penalties").select("*,users!penalties_user_id_fkey(username,steam_id,avatar)").order("created_at", { ascending: false });
    if (filters.type) query = query.eq("type", filters.type);
    const { data, error } = await query;
    legacyXError(error, "Unable to load penalties");
    const penalties = await mapPenaltiesWithProfileIdentities((data ?? []) as DbRow[], db());
    res.json(filters.query ? penalties.filter(penalty => penalty.player.toLowerCase().includes(filters.query!.toLowerCase())) : penalties);
  }));
  router.get("/moderation/penalties/stats", asyncRoute(async (_req, res) => {
    const { data, error } = await db().from("penalties").select("type,is_permanent,is_unbanned");
    legacyXError(error, "Unable to load penalty statistics");
    const penalties = (data ?? []) as DbRow[];
    res.json({ totalBans: penalties.filter(row => row.type === "ban").length, activeBans: penalties.filter(row => row.type === "ban" && !row.is_unbanned).length, permanentBans: penalties.filter(row => row.type === "ban" && row.is_permanent).length, totalComms: penalties.filter(row => row.type === "comm").length, totalGags: penalties.filter(row => row.type === "gag").length });
  }));
  // ---- Penalties from the website -------------------------------------------------------------------------------
  // Staff (Owner, Manager, Admin) lift, change or issue penalties on the same pages players read, with their normal
  // sign-in. Every change is written to the audit log.
  const loadModerator = async (userId: string) => {
    const { data, error } = await db().from("staff").select("role,permissions,immunity").eq("user_id", userId).eq("status", "active").maybeSingle();
    legacyXError(error, "Unable to verify staff access");
    return (data ?? null) as DbRow | null;
  };
  const requireModerator = async (userId: string, capability: ModerationCapability) => {
    const staff = await loadModerator(userId);
    if (!staff || !mayModerate(textValue(staff.role), staff.permissions, capability)) apiError(403, "Staff access is required");
    return staff;
  };
  const auditPenalty = async (actorId: string, action: string, targetId: string, metadata: Record<string, unknown>) => {
    const { error } = await db().from("audit_logs").insert({ actor_type: "user", actor_id: actorId, action, target_type: "penalty", target_id: targetId, metadata });
    if (error) console.error("[legacy-x-api] Unable to audit penalty change", error);
  };
  const loadChangeable = async (penaltyId: string) => {
    const { data: penalty, error } = await db().from("penalties").select("id,user_id,admin_id,type,reason,term,is_permanent,is_unbanned,expires_at").eq("id", penaltyId).maybeSingle();
    legacyXError(error, "Unable to load the penalty");
    if (!penalty) apiError(404, "Penalty was not found");
    const { data: ban, error: banError } = await db().from("bans").select("id,issuer_immunity,issuer_steam_id").eq("penalty_id", penaltyId).is("revoked_at", null).maybeSingle();
    legacyXError(banError, "Unable to load the ban");
    return { penalty: penalty as DbRow, ban: (ban ?? null) as DbRow | null };
  };
  router.get("/moderation/access", userRoute(async (_req, res, user) => {
    const staff = await loadModerator(user.id);
    const role = staff ? textValue(staff.role) : null;
    const waiting = staff ? await db().from("penalty_lift_requests").select("penalty_id").eq("requested_by", user.id).eq("status", "pending") : { data: [] };
    res.json({ canManage: Boolean(staff && ["ban", "unban", "edit"].some((capability) => mayModerate(role, staff.permissions, capability as ModerationCapability))), role, requestedPenaltyIds: ((waiting.data ?? []) as DbRow[]).map((row) => textValue(row.penalty_id)), canApprove: mayApproveLifts(role), can: { ban: Boolean(staff && mayModerate(role, staff.permissions, "ban")), unban: Boolean(staff && mayModerate(role, staff.permissions, "unban")), edit: Boolean(staff && mayModerate(role, staff.permissions, "edit")) } });
  }));
  /** Lifts one penalty (the ban row too). `actor` is whoever has the right to: the issuer, or a Manager or Owner. */
  const liftPenalty = async (penaltyId: string, actorId: string, actorName: string, reason: string | null, via: string) => {
    const { penalty, ban } = await loadChangeable(penaltyId);
    if (penalty.is_unbanned) apiError(409, "That penalty is already lifted");
    const { error } = await db().from("penalties").update({ is_unbanned: true, updated_at: new Date().toISOString() }).eq("id", penaltyId);
    legacyXError(error, "Unable to lift the penalty");
    if (ban) {
      const revoked = await db().from("bans").update({ revoked_at: new Date().toISOString(), revoked_by: actorId, revoke_reason: reason ?? `Lifted by ${actorName}` }).eq("id", textValue(ban.id));
      legacyXError(revoked.error, "Unable to lift the ban");
    }
    await auditPenalty(actorId, "penalty.lift", penaltyId, { type: textValue(penalty.type), reason, via });
  };
  const moderatorIds = async () => {
    const { data } = await db().from("staff").select("user_id").in("role", ["OWNER", "MANAGER"]).eq("status", "active");
    return ((data ?? []) as DbRow[]).map((row) => textValue(row.user_id));
  };
  router.post("/moderation/penalties/:penaltyId/lift", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const penaltyId = userIdSchema.parse(req.params.penaltyId);
    const input = z.object({ reason: z.string().trim().max(200).optional() }).strict().parse(req.body ?? {});
    const staff = await requireModerator(user.id, "unban");
    const role = textValue(staff.role);
    const { penalty, ban } = await loadChangeable(penaltyId);
    if (penalty.is_unbanned) apiError(409, "That penalty is already lifted");
    const own = penalty.admin_id === user.id || Boolean(ban && user.steamId && ban.issuer_steam_id === user.steamId);
    if (needsLiftApproval(role, own)) {
      // Someone else's penalty: an Admin asks, a Manager or Owner decides.
      const { error } = await db().from("penalty_lift_requests").insert({ penalty_id: penaltyId, requested_by: user.id, reason: input.reason ?? null });
      if (error?.code === "23505") apiError(409, "An unban is already requested for this penalty");
      legacyXError(error, "Unable to send the request");
      await auditPenalty(user.id, "penalty.lift_requested", penaltyId, { type: textValue(penalty.type), reason: input.reason ?? null });
      for (const managerId of await moderatorIds()) {
        const { error: tellError } = await db().from("notifications").insert({ user_id: managerId, kind: "system", title: "Unban request", body: `${user.username} asked to lift a ${textValue(penalty.type)}.`, metadata: { penaltyId, kind: "lift_request" } });
        if (tellError) console.warn("[legacy-x-api] unban request notification not saved", tellError.message);
      }
      res.status(202).json({ status: "requested" });
      return;
    }
    if (!own && ban && !mayTouchBan(role, numberValue(staff.immunity), numberValue(ban.issuer_immunity))) apiError(403, "That ban was issued by someone with higher immunity");
    await liftPenalty(penaltyId, user.id, user.username, input.reason ?? null, own ? "own" : "direct");
    res.json({ status: "lifted" });
  }));
  router.get("/moderation/lift-requests", userRoute(async (_req, res, user) => {
    const staff = await requireModerator(user.id, "unban");
    if (!mayApproveLifts(textValue(staff.role))) apiError(403, "Owner or Manager access is required");
    const { data, error } = await db().from("penalty_lift_requests").select("id,reason,created_at,requested_by,penalty_id,penalties(id,type,reason,users!penalties_user_id_fkey(username,avatar,steam_id))").eq("status", "pending").order("created_at");
    legacyXError(error, "Unable to load the requests");
    const rows = (data ?? []) as DbRow[];
    const ids = Array.from(new Set(rows.map((row) => textValue(row.requested_by))));
    const people = ids.length ? await db().from("users").select("id,username").in("id", ids) : { data: [], error: null };
    const names = new Map(((people.data ?? []) as DbRow[]).map((row) => [textValue(row.id), textValue(row.username)]));
    res.json(rows.map((row) => {
      const penalty = firstRow(row.penalties) ?? {};
      const target = firstRow(penalty.users) ?? {};
      return { id: textValue(row.id), penaltyId: textValue(row.penalty_id), type: textValue(penalty.type), player: textValue(target.username), avatar: textValue(target.avatar), penaltyReason: textValue(penalty.reason), reason: row.reason == null ? null : textValue(row.reason), requestedBy: names.get(textValue(row.requested_by)) ?? "Staff", at: textValue(row.created_at) };
    }));
  }));
  const decideLift = (approve: boolean) => userRoute(async (req, res, user) => {
    const requestId = userIdSchema.parse(req.params.requestId);
    const staff = await requireModerator(user.id, "unban");
    const role = textValue(staff.role);
    if (!mayApproveLifts(role)) apiError(403, "Owner or Manager access is required");
    const { data: request, error } = await db().from("penalty_lift_requests").select("id,penalty_id,requested_by,status").eq("id", requestId).maybeSingle();
    legacyXError(error, "Unable to load the request");
    if (!request) apiError(404, "There is no such request");
    if (request.status !== "pending") apiError(409, "That request was already decided");
    if (approve) {
      const { ban } = await loadChangeable(textValue(request.penalty_id));
      if (ban && !mayTouchBan(role, numberValue(staff.immunity), numberValue(ban.issuer_immunity))) apiError(403, "That ban was issued by someone with higher immunity");
      await liftPenalty(textValue(request.penalty_id), user.id, user.username, null, "approved");
    }
    const decided = await db().from("penalty_lift_requests").update({ status: approve ? "approved" : "declined", decided_by: user.id, decided_at: new Date().toISOString() }).eq("id", requestId);
    legacyXError(decided.error, "Unable to save the decision");
    await auditPenalty(user.id, approve ? "penalty.lift_approved" : "penalty.lift_declined", textValue(request.penalty_id), { requestId });
    await db().from("notifications").insert({ user_id: textValue(request.requested_by), kind: "system", title: approve ? "Unban approved" : "Unban declined", body: approve ? "Your unban request was approved." : "Your unban request was declined.", metadata: { penaltyId: textValue(request.penalty_id), kind: "lift_decision" } });
    res.status(204).end();
  });
  router.post("/moderation/lift-requests/:requestId/approve", sensitiveMutationRateLimit, decideLift(true));
  router.post("/moderation/lift-requests/:requestId/decline", sensitiveMutationRateLimit, decideLift(false));
  router.put("/moderation/penalties/:penaltyId", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const penaltyId = userIdSchema.parse(req.params.penaltyId);
    const input = z.object({ reason: z.string().trim().min(1).max(200).optional(), durationMinutes: z.number().int().min(0).max(525_600).optional() }).strict().refine((value) => value.reason !== undefined || value.durationMinutes !== undefined, "A reason or a length of time is required").parse(req.body);
    const staff = await requireModerator(user.id, "edit");
    const { penalty, ban } = await loadChangeable(penaltyId);
    if (penalty.is_unbanned) apiError(409, "A lifted penalty cannot be changed");
    if (ban && !mayTouchBan(textValue(staff.role), numberValue(staff.immunity), numberValue(ban.issuer_immunity))) apiError(403, "That ban was issued by someone with higher immunity");
    const fields = input.durationMinutes === undefined ? null : termFields(input.durationMinutes);
    const { error } = await db().from("penalties").update({ ...(input.reason !== undefined ? { reason: input.reason } : {}), ...(fields ?? {}), updated_at: new Date().toISOString() }).eq("id", penaltyId);
    legacyXError(error, "Unable to change the penalty");
    if (ban) {
      const update: Record<string, unknown> = { ...(input.reason !== undefined ? { reason: input.reason } : {}) };
      if (fields) {
        update.is_permanent = fields.is_permanent;
        update.expires_at = fields.expires_at;
        if (needsReview(textValue(staff.role), Boolean(fields.is_permanent))) update.review_status = "pending";
      }
      const changed = await db().from("bans").update(update).eq("id", textValue(ban.id));
      legacyXError(changed.error, "Unable to change the ban");
    }
    await auditPenalty(user.id, "penalty.edit", penaltyId, { type: textValue(penalty.type), before: { reason: textValue(penalty.reason), term: textValue(penalty.term) }, reason: input.reason ?? null, durationMinutes: input.durationMinutes ?? null });
    res.status(204).end();
  }));
  // A message from staff to one player, delivered to their notification bell.
  router.post("/moderation/notify", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const input = z.object({ steamId: z.string().regex(/^7656119\d{10}$/, "SteamID64 is required"), title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(500) }).strict().parse(req.body);
    await requireModerator(user.id, "edit");
    const { data: target, error: targetError } = await db().from("users").select("id").eq("steam_id", input.steamId).maybeSingle();
    legacyXError(targetError, "Unable to find the player");
    if (!target) apiError(404, "That player has not signed in to LEGACY-X yet");
    const { data, error } = await db().from("notifications").insert({ user_id: textValue(target.id), kind: "system", title: input.title, body: input.body, metadata: { kind: "staff_message", from: user.username } }).select("id").single();
    legacyXError(error, "Unable to send the notification");
    const { error: auditError } = await db().from("audit_logs").insert({ actor_type: "user", actor_id: user.id, action: "notification.send", target_type: "user", target_id: textValue(target.id), metadata: { title: input.title, notificationId: textValue(data?.id) } });
    if (auditError) console.error("[legacy-x-api] Unable to audit notification", auditError);
    res.status(201).json({ status: "sent" });
  }));
  router.post("/moderation/penalties", sensitiveMutationRateLimit, userRoute(async (req, res, user) => {
    const input = z.object({ steamId: z.string().regex(/^7656119\d{10}$/, "SteamID64 is required"), type: z.enum(["ban", "comm", "gag"]), durationMinutes: z.number().int().min(0).max(525_600), reason: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    const staff = await requireModerator(user.id, input.type === "ban" ? "ban" : "mute");
    const issued = input.type === "ban"
      ? await issueBan(db(), { steamId: input.steamId, durationMinutes: input.durationMinutes, reason: input.reason, issuerName: user.username, source: "panel", issuerSteamId: user.steamId || undefined })
      : await issueCommPenalty(db(), { steamId: input.steamId, type: input.type, durationMinutes: input.durationMinutes, reason: input.reason, issuerName: user.username });
    const penaltyId = issued.penaltyId;
    await db().from("penalties").update({ admin_id: user.id }).eq("id", penaltyId);
    await auditPenalty(user.id, "penalty.issue", penaltyId, { type: input.type, steamId: input.steamId, durationMinutes: input.durationMinutes, reason: input.reason });
    res.status(201).json({ penaltyId });
  }));
  router.get("/penalties/:penaltyId", asyncRoute(async (req, res) => {
    const { data, error } = await db().from("penalties").select("*,users!penalties_user_id_fkey(username,steam_id,avatar)").eq("id", userIdSchema.parse(req.params.penaltyId)).maybeSingle();
    legacyXError(error, "Unable to load penalty");
    if (!data) apiError(404, "Penalty was not found");
    const [penalty] = await mapPenaltiesWithProfileIdentities([data as DbRow], db());
    res.json(penalty);
  }));

  /** Reactions for the given reviews. Missing table (migration not applied): no reactions, the reviews still load. */
  const loadReactions = async (feedbackIds: string[], viewerId: string | null) => {
    if (!feedbackIds.length) return tallyReactions([], viewerId);
    const { data, error } = await db().from("feedback_reactions").select("feedback_id,user_id,reaction").in("feedback_id", feedbackIds);
    if (error) { if (!isMissingTableError(error)) console.warn("[legacy-x-api] reactions unavailable", error.message); return tallyReactions([], viewerId); }
    return tallyReactions((data ?? []) as DbRow[], viewerId);
  };
  router.get("/feedback", optionalUserRoute(async (_req, res, user) => {
    const { data, error } = await db().from("feedback").select("id,user_id,name,rating,message,created_at").order("created_at", { ascending: false });
    legacyXError(error, "Unable to load feedback");
    const entries = await mapFeedbackRows((data ?? []) as DbRow[]);
    const tally = await loadReactions(entries.map((entry) => entry.id), user?.id ?? null);
    res.json(entries.map((entry) => ({ ...entry, ...tally.summaryFor(entry.id) })));
  }));
  // One reaction per player per review: send one to set or change it, null to take it back.
  router.put("/feedback/:feedbackId/reaction", userRoute(async (req, res, user) => {
    const feedbackId = userIdSchema.parse(req.params.feedbackId);
    const input = z.object({ reaction: z.union([z.enum(["like", "love", "funny"]), z.null()]) }).strict().parse(req.body);
    const { data: review, error: reviewError } = await db().from("feedback").select("id").eq("id", feedbackId).maybeSingle();
    legacyXError(reviewError, "Unable to load the review");
    if (!review) apiError(404, "Review was not found");
    if (input.reaction === null) {
      const { error } = await db().from("feedback_reactions").delete().eq("feedback_id", feedbackId).eq("user_id", user.id);
      legacyXError(error, "Unable to remove the reaction");
    } else if (isReaction(input.reaction)) {
      const { error } = await db().from("feedback_reactions").upsert({ feedback_id: feedbackId, user_id: user.id, reaction: input.reaction }, { onConflict: "feedback_id,user_id" });
      legacyXError(error, "Unable to save the reaction");
    }
    res.json((await loadReactions([feedbackId], user.id)).summaryFor(feedbackId));
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
    const { data, error } = await db().from("users").select("id,steam_id,username,avatar,level,player_stats(*)").ilike("username", `%${input.query}%`).order("username");
    legacyXError(error, "Unable to search players");
    const worn = await equippedCosmeticsFor(((data ?? []) as DbRow[]).map((user) => textValue(user.id)));
    res.json({ players: ((data ?? []) as DbRow[]).map((user, index) => ({ ...mapLeaderFromUser(user, index), ...lookOf(worn, textValue(user.id)) })) });
  }));
  router.get("/search/clans", userRoute(async (req, res) => {
    const input = z.object({ query: z.string().trim().min(1).max(64) }).parse(req.query);
    const { data, error } = await db().from("clans").select("*,clan_members(count)").ilike("name", `%${input.query}%`).order("name");
    legacyXError(error, "Unable to search clans");
    res.json({ clans: ((data ?? []) as DbRow[]).map(mapClanCard) });
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
      if (!redirect) throw error;
      res.setHeader("Cache-Control", "no-store");
      // A player who pressed Cancel on Steam goes back to the site quietly; nothing failed.
      if (!staffPanel && req.query["openid.mode"] === "cancel") {
        res.redirect(302, new URL("/?login=cancelled", redirect).toString());
        return;
      }
      const trace = randomBytes(8).toString("hex");
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      console.error(`[legacy-x-api] ${staffPanel ? "staffpanel_callback_failed" : "steam_login_failed"}`, { trace, status, message: error instanceof Error ? error.message : "Unknown error" });
      // Back to the site with a short code the page turns into one line, never a raw JSON error page.
      if (!staffPanel) {
        res.redirect(302, new URL("/?login=failed", redirect).toString());
        return;
      }
      const code = status >= 500 ? "staff_setup_required" : "staff_auth_failed";
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

  const leaderboardHandler = asyncRoute(async (req, res) => {
    const { sort, limit, offset } = leaderboardSchema.parse(req.query);
    const { data, error, count } = await db().from("player_stats").select("*,users(id,steam_id,username,avatar,level,rank)", { count: "exact" }).order(sort, { ascending: false }).range(offset, offset + limit - 1);
    legacyXError(error, "Unable to load leaderboard");
    sendPage(res, data, count, limit, offset);
  });

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
  // Every CS2 server (LegacyX-Status) every 30 s: identity, map, mode and who is on it.
  router.post("/plugin/servers/heartbeat", pluginRoute("servers:write", async (req, res) => {
    const input = heartbeatSchema.parse(req.body);
    res.set("Cache-Control", "no-store");
    res.json(await ingestHeartbeat(db(), input));
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
    if (input.event_type === "result_final" && input.match_id && ["processed", "duplicate"].includes(textValue(matchCoreResult.status))) {
      competitive = await applyRankedMatchResult(pluginId, input.event_id, input.match_id, (input as DbRow).result);
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
  // In-game !calladmin / !callmanager: LegacyX-Admin posts the request, the Discord bot announces it.
  router.post("/plugin/admin-calls", pluginRoute("bans:write", async (req, res, plugin) => {
    const input = adminCallSchema.parse(req.body);
    res.set("Cache-Control", "no-store");
    const since = new Date(Date.now() - ADMIN_CALL_COOLDOWN_SECONDS * 1000).toISOString();
    let recentQuery = db().from("admin_calls").select("id").eq("caller_steam_id", input.callerSteamId).eq("target", input.target).gte("created_at", since);
    // Reports against different players are separate; the same player twice in a minute is not.
    if (input.target === "report" && input.reportedSteamId) recentQuery = recentQuery.eq("reported_steam_id", input.reportedSteamId);
    const recent = await recentQuery.limit(1);
    legacyXError(recent.error, "Unable to check recent admin calls");
    if ((recent.data ?? []).length > 0) {
      res.status(200).json({ recorded: false, reason: "cooldown" });
      return;
    }
    const { data, error } = await db().from("admin_calls").insert(adminCallRow(input)).select("id").single();
    legacyXError(error, "Unable to record the admin call");
    const callId = Number((data as DbRow | null)?.id);
    await writePluginAudit(plugin, "admin_call.create", "admin_calls", null, { id: callId, target: input.target, serverId: input.serverId, onlineStaff: input.onlineStaff })
      .catch((auditError) => console.error("[legacy-x-api] Unable to audit admin call", auditError));
    res.status(201).json({ recorded: true, id: callId });
  }));
  // The Discord bot's feed: new requests after an id, oldest first. Without `after` it only reports where the feed stands.
  router.get("/plugin/admin-calls", pluginRoute("discord:link", async (req, res) => {
    const after = parseAfter(req.query.after);
    res.set("Cache-Control", "no-store");
    const newest = await db().from("admin_calls").select("id").order("id", { ascending: false }).limit(1);
    legacyXError(newest.error, "Unable to read admin calls");
    const latestId = newest.data?.[0] ? Number(newest.data[0].id) : 0;
    if (after === null) {
      res.json({ calls: [], latestId });
      return;
    }
    const cutoff = new Date(Date.now() - ADMIN_CALL_MAX_AGE_HOURS * 3_600_000).toISOString();
    const { data, error } = await db().from("admin_calls").select("*").gt("id", after).gte("created_at", cutoff).order("id", { ascending: true }).limit(ADMIN_CALL_PAGE);
    legacyXError(error, "Unable to read admin calls");
    res.json({ calls: ((data ?? []) as AdminCallRecord[]).map(adminCallView), latestId });
  }));
  // Update announcements for Discord: the deploy scripts post, the bot's feed reads (see announcements.ts).
  router.post("/plugin/announcements", pluginRoute("announce:write", async (req, res, plugin) => {
    const input = announcementSchema.parse(req.body);
    res.set("Cache-Control", "no-store");
    const { data, error } = await db().from("update_announcements").insert(announcementRow(input)).select("id").single();
    legacyXError(error, "Unable to record the announcement");
    const id = Number((data as DbRow | null)?.id);
    await writePluginAudit(plugin, "announcement.create", "announcements", null, { id, title: input.title })
      .catch((auditError) => console.error("[legacy-x-api] Unable to audit announcement", auditError));
    res.status(201).json({ recorded: true, id });
  }));
  router.get("/plugin/announcements", pluginRoute("discord:link", async (req, res) => {
    const after = parseAfter(req.query.after);
    res.set("Cache-Control", "no-store");
    const newest = await db().from("update_announcements").select("id").order("id", { ascending: false }).limit(1);
    legacyXError(newest.error, "Unable to read announcements");
    const latestId = newest.data?.[0] ? Number(newest.data[0].id) : 0;
    if (after === null) {
      res.json({ announcements: [], latestId });
      return;
    }
    const cutoff = new Date(Date.now() - ANNOUNCEMENT_MAX_AGE_HOURS * 3_600_000).toISOString();
    const { data, error } = await db().from("update_announcements").select("*").gt("id", after).gte("created_at", cutoff).order("id", { ascending: true }).limit(ANNOUNCEMENT_PAGE);
    legacyXError(error, "Unable to read announcements");
    res.json({ announcements: ((data ?? []) as AnnouncementRecord[]).map(announcementView), latestId });
  }));
  // Central SteamID bans (Discord bot /ban, /unban). Game servers poll /plugin/bans/check and kick.
  router.post("/plugin/bans", pluginRoute("bans:write", async (req, res, plugin) => {
    const input = issueBanSchema.parse(req.body);
    const ban = await issueBan(db(), input);
    // Show the real Steam name and avatar on the penalties page when the Steam API is configured.
    await syncSteamUserProfile(input.steamId).catch(() => undefined);
    // The ban is already recorded; a failed audit write is logged instead of failing the request.
    await writePluginAudit(plugin, "ban.issue", "ban", ban.banId, { steamId: input.steamId, durationMinutes: input.durationMinutes, reason: input.reason, issuer: input.issuerName })
      .catch((error) => console.error("[legacy-x-api] Unable to audit ban", error));
    res.status(201).json({ ban, player: await bannedPlayer(db(), input.steamId) });
  }));
  router.post("/plugin/bans/revoke", pluginRoute("bans:write", async (req, res, plugin) => {
    const input = revokeBanSchema.parse(req.body);
    const result = await revokeBans(db(), input);
    // audit_logs.target_id is a UUID, so the SteamID goes in metadata. The bans are already lifted;
    // a failed audit write is logged instead of failing the request.
    await writePluginAudit(plugin, "ban.revoke", "ban", null, { steamId: input.steamId, ...result, issuer: input.issuerName, reason: input.reason ?? null })
      .catch((error) => console.error("[legacy-x-api] Unable to audit ban lift", error));
    res.json({ ...result, player: await bannedPlayer(db(), input.steamId) });
  }));
  // Discord /link: the bot asks for a one-time URL; the player opens it and signs in with Steam. The
  // public link lives under /auth/steam so it shares the auth rate limit and the legacyx.cc callback proxy.
  router.post("/plugin/discord/link-requests", pluginRoute("discord:link", async (req, res) => {
    const input = linkRequestSchema.parse(req.body);
    const { token, expiresAt } = await createLinkRequest(db(), input);
    res.set("Cache-Control", "no-store");
    res.status(201).json({ url: linkStartUrl(steamOpenIdOrigin(req), token), expiresAt });
  }));
  router.get("/plugin/discord/links", pluginRoute("discord:link", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ links: await listLinks(db()) });
  }));
  router.get("/plugin/discord/links/:discordId", pluginRoute("discord:link", async (req, res) => {
    const discordId = discordIdSchema.parse(req.params.discordId);
    const [link] = await listLinks(db(), discordId);
    if (!link) apiError(404, "Discord account is not linked");
    res.set("Cache-Control", "no-store");
    res.json({ link });
  }));
  router.delete("/plugin/discord/links/:discordId", pluginRoute("discord:link", async (req, res) => {
    const discordId = discordIdSchema.parse(req.params.discordId);
    res.json({ unlinked: await unlink(db(), discordId) });
  }));

  const sendLinkPage = (res: Response, status: number, ok: boolean, title: string, message: string) => {
    const page = linkResultPage(ok, title, message);
    res.status(status).set({ "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": page.csp }).send(page.html);
  };
  const expiredLink = (res: Response) => sendLinkPage(res, 410, false, "Холбоос хүчингүй", "Энэ холбоосын хугацаа дууссан эсвэл ашиглагдсан байна. Discord дээр /link командыг дахин ажиллуулна уу.");
  // Linking Discord from the website (the signed-in player starts it, Discord proves who they are).
  router.get("/discord/link", userRoute(async (_req, res, user) => {
    res.set("Cache-Control", "no-store");
    res.json({ available: discordOAuthConfig() !== null, link: await ownDiscordLink(db(), user.id) });
  }));
  router.post("/discord/link/start", sensitiveMutationRateLimit, userRoute(async (_req, res, user) => {
    const config = discordOAuthConfig();
    if (!config) apiError(503, "Linking Discord from the website is not set up yet");
    const state = await createOAuthState(db(), user.id);
    res.set("Cache-Control", "no-store");
    res.json({ url: authorizeUrl(config, state) });
  }));
  router.delete("/discord/link", sensitiveMutationRateLimit, userRoute(async (_req, res, user) => {
    await removeOwnDiscordLink(db(), user.id);
    res.status(204).end();
  }));
  router.get("/auth/discord/callback", asyncRoute(async (req, res) => {
    const back = (result: string) => res.set("Cache-Control", "no-store").redirect(302, `${steamOpenIdOrigin(req)}/settings?discord=${result}`);
    const config = discordOAuthConfig();
    const { code, state, error } = req.query as Record<string, unknown>;
    if (!config) return back("unavailable");
    if (typeof error === "string" || typeof code !== "string" || !code || code.length > 512 || !isOAuthState(state)) return back("cancelled");
    const userId = await consumeOAuthState(db(), state);
    if (!userId) return back("expired");
    try {
      const identity = await fetchDiscordIdentity(config, code);
      await linkDiscordAccount(db(), userId, identity);
      await awardDiscordLink(db(), userId, (message, error) => console.error(`[legacy-x-api] ${message}`, error));
    } catch (failure) {
      console.warn("[legacy-x-api] Discord link failed", failure instanceof Error ? failure.message : failure);
      return back("failed");
    }
    return back("linked");
  }));
  router.get("/auth/steam/discord/:token", asyncRoute(async (req, res) => {
    const token = req.params.token;
    if (!isLinkToken(token) || !(await pendingLinkRequest(db(), token))) return expiredLink(res);
    const origin = steamOpenIdOrigin(req);
    res.set("Cache-Control", "no-store");
    res.redirect(302, steamLoginUrl(origin, linkCallbackUrl(origin, token)));
  }));
  router.get("/auth/steam/discord/:token/callback", asyncRoute(async (req, res) => {
    const token = req.params.token;
    if (!isLinkToken(token)) return expiredLink(res);
    const request = await pendingLinkRequest(db(), token);
    if (!request) return expiredLink(res);
    const query = req.query as Record<string, unknown>;
    let steamId: string;
    try {
      if (!returnToMatches(query, linkCallbackUrl(steamOpenIdOrigin(req), token))) apiError(401, "Steam response was not issued for this link");
      steamId = await verifySteamCallback(query);
    } catch {
      return sendLinkPage(res, 401, false, "Steam баталгаажуулалт амжилтгүй", "Steam нэвтрэлтийг баталгаажуулж чадсангүй. Discord дээрх холбоосыг дахин нээнэ үү.");
    }
    const { data: userId, error } = await db().rpc("ensure_steam_user", { p_steam_id: steamId, p_username: `Steam ${steamId}`, p_avatar: "" });
    legacyXError(error, "Unable to create Steam user");
    if (!userId) apiError(500, "Steam user was not created");
    await syncSteamUserProfile(steamId).catch(() => undefined);
    if (!(await completeLink(db(), token, userId))) return expiredLink(res);
    const { data: user } = await db().from("users").select("username").eq("id", userId).maybeSingle();
    const steamName = typeof user?.username === "string" && user.username ? user.username : steamId;
    sendLinkPage(res, 200, true, "Амжилттай холбогдлоо", `Discord акаунт ${request.discordName || request.discordId} нь Steam акаунт ${steamName}-тэй холбогдлоо. Rank role хэдэн секундын дотор Discord дээр гарч ирнэ.`);
  }));
  // !cleanbans on a CS2 server: every ban lifted everywhere, only for a website OWNER.
  router.post("/plugin/bans/revoke-all", pluginRoute("bans:write", async (req, res, plugin) => {
    const input = revokeAllBansSchema.parse(req.body);
    const result = await revokeAllBans(db(), input);
    await writePluginAudit(plugin, "ban.revoke_all", "ban", null, { ...result, issuer: input.issuerName, issuerSteamId: input.issuerSteamId })
      .catch((error) => console.error("[legacy-x-api] Unable to audit ban wipe", error));
    res.json(result);
  }));
  // In-game voice mutes and chat gags (LegacyX-Admin): the public record next to the bans.
  router.post("/plugin/penalties", pluginRoute("bans:write", async (req, res, plugin) => {
    const input = issueCommPenaltySchema.parse(req.body);
    const penalty = await issueCommPenalty(db(), input);
    await syncSteamUserProfile(input.steamId).catch(() => undefined);
    await writePluginAudit(plugin, `${input.type}.issue`, "penalties", penalty.penaltyId, { steamId: input.steamId, durationMinutes: input.durationMinutes, reason: input.reason, issuer: input.issuerName })
      .catch((error) => console.error("[legacy-x-api] Unable to audit penalty", error));
    res.status(201).json({ penalty });
  }));
  router.post("/plugin/penalties/revoke", pluginRoute("bans:write", async (req, res, plugin) => {
    const input = liftCommPenaltySchema.parse(req.body);
    const result = await liftCommPenalties(db(), input);
    await writePluginAudit(plugin, `${input.type}.revoke`, "penalties", null, { steamId: input.steamId, ...result, issuer: input.issuerName })
      .catch((error) => console.error("[legacy-x-api] Unable to audit penalty lift", error));
    res.json(result);
  }));
  router.post("/plugin/bans/check", pluginRoute("bans:read", async (req, res) => {
    const input = checkBansSchema.parse(req.body);
    res.json({ bans: await activeBans(db(), input.steamIds) });
  }));

  // LegacyX-Admin asks which connected players are staff on its server; it grants in-game permissions only for authorized answers.
  router.post("/plugin/admin/authorizations", pluginRoute("admin:read", async (req, res, plugin) => {
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-admin") apiError(403, "LegacyX Admin plugin identity is required");
    const input = authorizationRequestSchema.parse(req.body);
    res.set("Cache-Control", "no-store");
    res.json({ serverId: input.serverId, checkedAt: new Date().toISOString(), players: await resolveAuthorizations(db(), input) });
  }));

  // In-game !xp / !rank: the player's rank on the Legacy-X ladder (the same source as the website).
  router.get("/plugin/community/players/:steamId", pluginRoute("stats:write", async (req, res) => {
    const steamId = String(req.params.steamId || "").trim();
    if (!/^\d{15,20}$/.test(steamId)) apiError(400, "steamId must be a 15-20 digit SteamID64");
    const { data, error } = await db().from("competitive_player_profiles").select("user_id,steam_id,username,current_exp,rank_id,rank_name,current_rank_min_exp,next_rank_name,next_rank_min_exp,pro_league_unlocked,matches_completed").eq("steam_id", steamId).maybeSingle();
    legacyXError(error, "Unable to load plugin player rank");
    if (!data) apiError(404, "Player profile not found");
    const membership = await db().from("clan_members").select("role,clans(name,tag)").eq("user_id", data.user_id).maybeSingle();
    if (membership.error) console.warn("[legacy-x-api] clan lookup unavailable", membership.error.message);
    const clan = recordValue(recordValue(membership.data).clans);
    const { user_id: _userId, ...profile } = data;
    const { data: ladder } = await db().from("competitive_leaderboard").select("position").eq("user_id", data.user_id).maybeSingle();
    res.json({ profile: {
      ...profile,
      position: ladder ? numberValue((ladder as DbRow).position) : null,
      clan_name: textValue(clan.name) || null,
      clan_tag: textValue(clan.tag) || null,
      clan_role: textValue(recordValue(membership.data).role) || null,
    } });
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
    if (pluginId !== "legacyx-live-snapshot") apiError(403, "Live snapshot plugin identity is required");
    const result = await ingestLiveMatchSnapshot(pluginId, input.event_id, input.server_id, input.live_match);
    // Not audited: snapshots arrive every 30 s per server (like heartbeats); they are telemetry, not staff actions.
    res.status(200).json({ result });
  }));
  router.post("/plugin/killfeed/events", pluginRoute("servers:write", async (req, res) => {
    const events = z.union([killEventSchema, z.array(killEventSchema).min(1).max(50)]).parse(req.body);
    const accepted = (Array.isArray(events) ? events : [events]).filter(event => killFeed.add(event)).length;
    res.status(202).json({ accepted });
  }));

  router.use((_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  router.use((error: Error & { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "Validation failed" });
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error("[legacy-x-api]", error);
    // A stable code (clan_full, ...) lets the website word the problem; only ones we set ourselves are sent.
    const code = status < 500 && typeof error.code === "string" && /^clan_[a-z_]{2,40}$/.test(error.code) ? error.code : undefined;
    res.status(status).json({ error: status >= 500 ? "Unexpected server error" : (error.message || "Request failed"), ...(code ? { code } : {}) });
  });

  return router;
}
