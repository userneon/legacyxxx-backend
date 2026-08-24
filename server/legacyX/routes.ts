import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { parseCookieHeader } from "../_core/cookieHeader";
import {
  authenticatePlugin,
  createRefreshSession,
  isStaffRole,
  isUserRole,
  issueAccessToken,
  refreshLifetimeMs,
  revokeRefreshSession,
  revokeUserRefreshSessions,
  rotateRefreshSession,
  steamLoginUrl,
  verifyAccessToken,
  verifySteamCallback,
  type LegacyUser,
  type PluginPrincipal,
  type UserRole,
} from "./auth";
import { apiRateLimitMax } from "./config";
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
    if (!user.isStaff) apiError(403, "Staff access is required");
    await handler(req, res, user);
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

function postLoginRedirect() {
  const configured = process.env.POST_LOGIN_REDIRECT?.trim();
  if (configured) return configured;
  return process.env.FRONTEND_ORIGIN?.trim() || null;
}

async function getUserWithStats(id: string) {
  const { data, error } = await legacyXDb()
    .from("users")
    .select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level,role,is_staff,created_at,updated_at,player_stats(*)")
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
  if (/^https:\/\//i.test(key)) return key;
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
const userIdSchema = z.string().uuid();
const playModeSchema = z.enum(["5vs5", "fun", "proleague", "tournaments"]);
const matchStatusSchema = z.enum(["live", "waiting", "finished", "locked"]);
const serverStatusSchema = z.enum(["online", "offline", "full"]);
const tournamentMatchStatusSchema = z.enum(["live", "upcoming", "completed"]);
const penaltyTypeSchema = z.enum(["ban", "comm", "gag"]);
const userRoleSchema = z.enum(["Owner", "Founder", "Manager", "Admin", "Player", "Designer", "Developer"]);
const shopRaritySchema = z.enum(["Common", "Rare", "Epic", "Legendary"]);
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
  const role: UserRole = isUserRole(user.role) ? user.role : "Player";
  const profile: Record<string, unknown> = {
    id: textValue(user.id),
    steamId: textValue(user.steam_id),
    username: textValue(user.username),
    avatar: textValue(user.avatar),
    level: numberValue(user.level),
    rank: textValue(user.rank),
    balance: numberValue(user.balance),
    role,
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
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    if (req.method === "OPTIONS") return res.sendStatus(403);
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
      db().from("users").select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level,role,is_staff,player_stats(*)").eq("id", id).maybeSingle(),
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
      .select("version,updated_at,skinchanger_loadout_entries(catalog_item_id,slot,slot_key,team_scope,options,skinchanger_catalog_items(id,external_key,category,weapon_class,display_name,weapon_defindex,paint_id,model,image_key,metadata))")
      .eq("user_id", user.id)
      .maybeSingle();
    legacyXError(error, "Unable to load skinchanger loadout");
    const loadout = data ?? { version: 0, updated_at: null, skinchanger_loadout_entries: [] };
    const entries = (loadout.skinchanger_loadout_entries ?? []) as DbRow[];
    const accessoryIds = Array.from(new Set(entries.flatMap((entry) => {
      const options = recordValue(entry.options);
      const stickers = Array.isArray(options.stickers) ? options.stickers : [];
      const stickerIds = stickers.map((sticker: unknown) => textValue(recordValue(sticker).catalogItemId)).filter(Boolean);
      const charmId = textValue(recordValue(options.charm).catalogItemId);
      return charmId ? [...stickerIds, charmId] : stickerIds;
    })));
    const catalogItemForResponse = (item: DbRow | null) => {
      if (!item) return null;
      return { ...item, image_url: staticStorageUrl(_req, textValue(item.image_key) || null) };
    };
    let accessoryById = new Map<string, DbRow>();
    if (accessoryIds.length) {
      const { data: accessories, error: accessoryError } = await db().from("skinchanger_catalog_items")
        .select("id,external_key,category,weapon_class,display_name,weapon_defindex,paint_id,model,image_key,metadata")
        .in("id", accessoryIds)
        .eq("is_active", true);
      legacyXError(accessoryError, "Unable to resolve skinchanger accessories");
      accessoryById = new Map(((accessories ?? []) as DbRow[]).map((item) => [textValue(item.id), catalogItemForResponse(item) as DbRow]));
    }
    const enrichedEntries = entries.map((entry) => {
      const options = recordValue(entry.options);
      const stickers = Array.isArray(options.stickers) ? options.stickers : [];
      const ids = stickers.map((sticker: unknown) => textValue(recordValue(sticker).catalogItemId)).filter(Boolean);
      const charmId = textValue(recordValue(options.charm).catalogItemId);
      if (charmId) ids.push(charmId);
      return {
        ...entry,
        skinchanger_catalog_items: catalogItemForResponse(firstRow(entry.skinchanger_catalog_items)),
        resolved_accessories: ids.map((id: string) => accessoryById.get(id)).filter(Boolean),
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
    noBody(req);
    const { error } = await db().rpc("purchase_store_item", { p_user_id: user.id, p_item_id: userIdSchema.parse(req.params.itemId) });
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
      apiError(429, nextEligibleAt ? `You can submit your next review after ${nextEligibleAt}.` : "You can submit one review every 7 days.");
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

  const beginSteam = (req: Request, res: Response) => res.redirect(302, steamLoginUrl(steamOpenIdOrigin(req)));
  router.get("/auth/steam", beginSteam);
  router.post("/auth/steam", beginSteam);
  router.get("/auth/steam/callback", asyncRoute(async (req, res) => {
    const steamId = await verifySteamCallback(req.query as Record<string, unknown>);
    const { data: userId, error } = await db().rpc("ensure_steam_user", { p_steam_id: steamId, p_username: `Steam ${steamId}`, p_avatar: "" });
    legacyXError(error, "Unable to create Steam user");
    if (!userId) apiError(500, "Steam user was not created");
    await syncSteamUserProfile(steamId);
    const user = await getUserWithStats(userId);
    const role: UserRole = isUserRole(user.role) ? user.role : "Player";
    const principal: LegacyUser = { id: user.id, steamId: user.steam_id, username: user.username, role, isStaff: isStaffRole(role) };
    const [accessToken, refreshToken] = await Promise.all([issueAccessToken(principal), createRefreshSession(principal.id)]);
    res.cookie("legacyx_access_token", accessToken, sessionCookieOptions(15 * 60 * 1000));
    res.cookie("legacyx_refresh_token", refreshToken, sessionCookieOptions(30 * 24 * 60 * 60 * 1000));
    const redirect = postLoginRedirect();
    if (redirect) {
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, redirect);
      return;
    }
    apiError(500, "POST_LOGIN_REDIRECT or FRONTEND_ORIGIN must be configured for Steam login");
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
    const { data, error } = await db().from("users").update(updates).eq("id", user.id).select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level,role,is_staff").single();
    legacyXError(error, "Unable to update profile");
    res.json({ profile: data });
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
  router.get("/feedback", asyncRoute(async (_req, res) => {
    const { data, error } = await db().from("feedback").select("*").order("created_at", { ascending: false });
    legacyXError(error, "Unable to load feedback");
    res.json({ feedback: data ?? [] });
  }));
  router.post("/feedback", asyncRoute(async (req, res) => {
    const input = feedbackSchema.parse(req.body);
    let user: LegacyUser | undefined;
    try { user = await requireUser(req); } catch { user = undefined; }
    if (!user && !input.name) apiError(401, "Anonymous feedback requires a display name");
    const { data, error } = await db().from("feedback").insert({ user_id: user?.id ?? null, name: user?.username ?? input.name!, rating: input.rating, message: input.message }).select("*").single();
    legacyXError(error, "Unable to submit feedback");
    res.status(201).json({ feedback: data });
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
    const input = z.object({ event_id: z.string().uuid(), event: z.enum(["match_created", "state_transition", "player_disconnected", "player_returned", "fill_assigned", "fill_removed", "snapshot_saved", "result_final", "match_cancelled"]), match_id: z.string().uuid().optional() }).passthrough().parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-match-core") apiError(403, "Match Core plugin identity is required");
    const { data, error } = await db().schema("legacy_x").rpc("ingest_core_match_event", { p_plugin_id: pluginId, p_event_id: input.event_id, p_payload: input });
    legacyXError(error, "Unable to ingest Match Core event");
    res.status(200).json({ result: data ?? {} });
  }));
  router.post("/plugin/matchzy/events", pluginRoute("stats:write", async (req, res, plugin) => {
    const input = z.object({ event_id: z.string().uuid(), event: z.string().min(1).max(64) }).passthrough().parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "matchzy") apiError(403, "MatchZy plugin identity is required");
    if (input.event !== "map_result") {
      res.status(202).json({ accepted: true, ignored: true });
      return;
    }
    const [rankResult, communityResult] = await Promise.all([
      db().schema("legacy_x").rpc("ingest_rank_map_result", { p_plugin_id: pluginId, p_event_id: input.event_id, p_payload: input }),
      db().schema("legacy_x").rpc("ingest_community_map_result", { p_plugin_id: pluginId, p_event_id: input.event_id, p_payload: input }),
    ]);
    legacyXError(rankResult.error || communityResult.error, "Unable to ingest MatchZy map result");
    res.status(201).json({ accepted: true, rank: rankResult.data ?? null, community: communityResult.data ?? null });
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
  router.post("/plugin/reconnect/events", pluginRoute("servers:write", async (req, res, plugin) => {
    const input = z.object({ event: z.enum(["player_connected", "player_disconnected", "server_heartbeat"]), event_id: z.string().min(8).max(180), server_id: z.string().min(1).max(120), server_address: z.string().min(1).max(255), map_name: z.string().max(128).optional().default(""), mode: z.string().max(128).optional().default(""), player_count: z.coerce.number().int().min(0).max(128).optional(), session_id: z.string().uuid().optional(), steam_id: z.string().regex(/^\d{15,20}$/).optional(), player_name: z.string().max(128).optional().default(""), disconnect_reason: z.string().max(96).optional().default(""), reconnect_window_minutes: z.coerce.number().int().min(5).max(1440).optional().default(720) }).parse(req.body);
    const pluginId = req.header("x-plugin-id")?.trim() || plugin.name;
    if (pluginId !== "legacyx-reconnect") apiError(403, "Reconnect plugin identity is required");
    if (input.event === "server_heartbeat") {
      const { data, error } = await db().schema("legacy_x").rpc("ingest_reconnect_heartbeat", { p_event_id: input.event_id, p_plugin_id: pluginId, p_server_id: input.server_id, p_server_address: input.server_address, p_map_name: input.map_name, p_mode: input.mode, p_player_count: input.player_count ?? 0 });
      legacyXError(error, "Unable to ingest reconnect server heartbeat");
      res.status(200).json({ result: data ?? {} });
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
    if (error instanceof z.ZodError) return res.status(400).json({ error: "Validation failed", details: error.flatten() });
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error("[legacy-x-api]", error);
    res.status(status).json({ error: error.message || "Unexpected server error" });
  });

  return router;
}
