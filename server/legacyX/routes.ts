import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { parseCookieHeader } from "../_core/cookieHeader";
import {
  authenticatePlugin,
  createRefreshSession,
  issueAccessToken,
  revokeRefreshSession,
  revokeUserRefreshSessions,
  rotateRefreshSession,
  steamLoginUrl,
  verifyAccessToken,
  verifySteamCallback,
  type LegacyUser,
  type PluginPrincipal,
} from "./auth";
import { apiRateLimitMax } from "./config";
import { legacyXDb, legacyXError } from "./supabase";
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
    const plugin = await authenticatePlugin(bearer(req), scope);
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
    .select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level,is_staff,created_at,updated_at,player_stats(*)")
    .eq("id", id)
    .maybeSingle();
  legacyXError(error, "Unable to load player");
  if (!data) apiError(404, "Player was not found");
  return data;
}

function sendPage(res: Response, data: unknown, count: number | null, limit: number, offset: number) {
  res.json({ data, pagination: { limit, offset, total: count ?? 0 } });
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
const shopRaritySchema = z.enum(["Common", "Rare", "Epic", "Legendary"]);

type DbRow = Record<string, any>;

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "";
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

function mapLeader(stats: DbRow, index: number) {
  const user = firstRow(stats.users) ?? {};
  return { rank: index + 1, name: textValue(user.username), level: numberValue(user.level), experience: numberValue(stats.experience), kills: numberValue(stats.kills), deaths: numberValue(stats.deaths), kd: numberValue(stats.kd_ratio), headshots: numberValue(stats.headshots), playedHours: numberValue(stats.played_hours), lastPlayed: timestampValue(stats.last_played_at), avatar: textValue(user.avatar) };
}

function mapLeaderFromUser(user: DbRow, index: number) {
  const stats = statsRow(user);
  return { rank: index + 1, name: textValue(user.username), level: numberValue(user.level), experience: numberValue(stats.experience), kills: numberValue(stats.kills), deaths: numberValue(stats.deaths), kd: numberValue(stats.kd_ratio), headshots: numberValue(stats.headshots), playedHours: numberValue(stats.played_hours), lastPlayed: timestampValue(stats.last_played_at), avatar: textValue(user.avatar) };
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
  return { id: textValue(user.id || member.user_id), name: textValue(user.username), role: textValue(member.role), avatar: textValue(user.avatar), description: "" };
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

function mapPenalty(penalty: DbRow) {
  const user = firstRow(penalty.users) ?? {};
  return { id: textValue(penalty.id), type: textValue(penalty.type), player: textValue(user.username), avatar: textValue(user.avatar), reason: textValue(penalty.reason), term: textValue(penalty.term), isPermanent: Boolean(penalty.is_permanent), isUnbanned: Boolean(penalty.is_unbanned), admin: textValue(penalty.admin_name), date: timestampValue(penalty.created_at) };
}

function mapFeedback(feedback: DbRow) {
  return { id: textValue(feedback.id), name: textValue(feedback.name), rating: numberValue(feedback.rating), message: textValue(feedback.message), date: timestampValue(feedback.created_at) };
}

function noBody(req: Request) {
  if (req.body && Object.keys(req.body).length > 0) apiError(400, "This endpoint does not accept a request body");
}

export function createLegacyXRouter() {
  const router = Router();
  const db = () => legacyXDb();

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

  const resolveUserId = (rawUserId: string, caller: LegacyUser) => rawUserId === "me" ? caller.id : userIdSchema.parse(rawUserId);
  const loadProfile = async (id: string) => {
    const [userResult, linksResult] = await Promise.all([
      db().from("users").select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level,is_staff,player_stats(*)").eq("id", id).maybeSingle(),
      db().from("user_links").select("url").eq("user_id", id).order("created_at"),
    ]);
    legacyXError(userResult.error || linksResult.error, "Unable to load profile");
    if (!userResult.data) apiError(404, "Player was not found");
    return { user: userResult.data as DbRow, links: (linksResult.data ?? []) as DbRow[] };
  };
  const loadClanDetail = async (clanId: string) => {
    const [clanResult, membersResult] = await Promise.all([
      db().from("clans").select("*,clan_members(count)").eq("id", clanId).maybeSingle(),
      db().from("clan_members").select("role,user_id,users(id,username,avatar)").eq("clan_id", clanId).order("created_at"),
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
    res.cookie("legacyx_refresh_token", nextRefreshToken, sessionCookieOptions(30 * 24 * 60 * 60 * 1000));
    res.json({ accessToken, refreshToken: nextRefreshToken, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), user: mapUserProfile(profile.user, profile.links) });
  }));
  router.get("/auth/me", userRoute(async (_req, res, user) => {
    const profile = await loadProfile(user.id);
    res.json(mapUserProfile(profile.user, profile.links));
  }));

  router.get("/profile/:userId", userRoute(async (req, res, user) => {
    const profile = await loadProfile(resolveUserId(req.params.userId, user));
    res.json(mapUserProfile(profile.user, profile.links));
  }));
  router.put("/profile/me", userRoute(async (req, res, user) => {
    const updates = profileUpdateSchema.parse(req.body);
    if (Object.keys(updates).length === 0) apiError(400, "At least one profile field is required");
    const { error } = await db().from("users").update(updates).eq("id", user.id);
    legacyXError(error, "Unable to update profile");
    const profile = await loadProfile(user.id);
    res.json(mapUserProfile(profile.user, profile.links));
  }));
  router.get("/profile/:userId/stats", userRoute(async (req, res, user) => {
    const userId = resolveUserId(req.params.userId, user);
    const { data, error } = await db().from("player_stats").select("matches,wins,kd_ratio,rating").eq("user_id", userId).maybeSingle();
    legacyXError(error, "Unable to load player stats");
    if (!data) apiError(404, "Player stats were not found");
    res.json(mapProfileStats(data as DbRow));
  }));
  router.get("/profile/:userId/matches", userRoute(async (req, res, user) => {
    const userId = resolveUserId(req.params.userId, user);
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
    const userId = resolveUserId(req.params.userId, user);
    const { data, error } = await db().from("penalties").select("*,users!penalties_user_id_fkey(username,avatar)").eq("user_id", userId).order("created_at", { ascending: false });
    legacyXError(error, "Unable to load penalties");
    res.json(((data ?? []) as DbRow[]).map(mapPenalty));
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
    const { data, error } = await db().from("player_stats").select("*,users!inner(id,username,avatar,level)").order("rating", { ascending: false });
    legacyXError(error, "Unable to load leaderboard");
    res.json(((data ?? []) as DbRow[]).map(mapLeader));
  });
  router.get("/leaderboard", frontendLeaderboard);
  router.get("/players/leaderboard", frontendLeaderboard);
  router.get("/players/:playerId", userRoute(async (req, res) => {
    const playerId = userIdSchema.parse(req.params.playerId);
    const { data, error } = await db().from("player_stats").select("*,users!inner(id,username,avatar,level)").order("rating", { ascending: false });
    legacyXError(error, "Unable to load player");
    const rows = (data ?? []) as DbRow[];
    const index = rows.findIndex(row => textValue(row.user_id) === playerId);
    if (index < 0) apiError(404, "Player was not found");
    res.json(mapLeader(rows[index]!, index));
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
    let query = db().from("penalties").select("*,users!penalties_user_id_fkey(username,avatar)").order("created_at", { ascending: false });
    if (filters.type) query = query.eq("type", filters.type);
    const { data, error } = await query;
    legacyXError(error, "Unable to load penalties");
    const penalties = ((data ?? []) as DbRow[]).map(mapPenalty);
    res.json(filters.query ? penalties.filter(penalty => penalty.player.toLowerCase().includes(filters.query!.toLowerCase())) : penalties);
  }));
  router.get("/moderation/penalties/stats", userRoute(async (_req, res) => {
    const { data, error } = await db().from("penalties").select("type,is_permanent,is_unbanned");
    legacyXError(error, "Unable to load penalty statistics");
    const penalties = (data ?? []) as DbRow[];
    res.json({ totalBans: penalties.filter(row => row.type === "ban").length, activeBans: penalties.filter(row => row.type === "ban" && !row.is_unbanned).length, permanentBans: penalties.filter(row => row.type === "ban" && row.is_permanent).length, totalComms: penalties.filter(row => row.type === "comm").length, totalGags: penalties.filter(row => row.type === "gag").length });
  }));
  router.get("/penalties/:penaltyId", userRoute(async (req, res) => {
    const { data, error } = await db().from("penalties").select("*,users!penalties_user_id_fkey(username,avatar)").eq("id", userIdSchema.parse(req.params.penaltyId)).maybeSingle();
    legacyXError(error, "Unable to load penalty");
    if (!data) apiError(404, "Penalty was not found");
    res.json(mapPenalty(data as DbRow));
  }));

  router.get("/feedback", userRoute(async (_req, res) => {
    const { data, error } = await db().from("feedback").select("id,name,rating,message,created_at").order("created_at", { ascending: false });
    legacyXError(error, "Unable to load feedback");
    res.json(((data ?? []) as DbRow[]).map(mapFeedback));
  }));
  router.post("/feedback", userRoute(async (req, res, user) => {
    const input = z.object({ rating: z.number().int().min(1).max(5), message: z.string().trim().min(1).max(4000) }).parse(req.body);
    const { data, error } = await db().from("feedback").insert({ user_id: user.id, name: user.username, rating: input.rating, message: input.message }).select("id,name,rating,message,created_at").single();
    legacyXError(error, "Unable to submit feedback");
    res.status(201).json(mapFeedback(data as DbRow));
  }));

  router.get("/search/players", userRoute(async (req, res) => {
    const input = z.object({ query: z.string().trim().min(1).max(64) }).parse(req.query);
    const { data, error } = await db().from("users").select("id,username,avatar,level,player_stats(*)").ilike("username", `%${input.query}%`).order("username");
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
    res.json({ creators: creators.data ?? [], partners: (partners.data ?? []).map((partner: DbRow) => ({ id: textValue(partner.id), name: textValue(partner.name), description: textValue(partner.description), type: textValue(partner.type) as "website" | "discord", url: textValue(partner.url) })) });
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
    const principal: LegacyUser = { id: user.id, steamId: user.steam_id, username: user.username, isStaff: user.is_staff };
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
    const { data, error } = await db().from("users").update(updates).eq("id", user.id).select("id,steam_id,username,avatar,level,rank,balance,faceit_username,faceit_elo,faceit_level,is_staff").single();
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
    const input = z.object({ kind: z.enum(["creator", "partner"]), name: z.string().trim().min(1).max(100), handle: z.string().trim().max(100).optional(), description: z.string().trim().max(2000).optional(), type: z.enum(["website", "discord"]).optional(), url: z.string().url().max(2048) }).parse(req.body);
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
