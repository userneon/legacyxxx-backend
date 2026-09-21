/** Panel moderation: kick, bans, mutes, the review queue, appeals, reports and the audit log. */
import { Router } from "express";
import { z } from "zod";
import { apiError, userRoute } from "../http";
import { legacyXDb, legacyXError } from "../supabase";
import { adminRoute, steamIdPattern, writeAudit } from "./context";
import { activeBan, changeBanDuration, issueBan, issueMute, kickPlayer, maxDurationMinutes, revokeBan, revokeMute, reviewBan, type Duration } from "./moderation";
import { checkRevokeBan, can, type Principal } from "./permissions";
import { mapAuditRows, mapPunishment, mapReports } from "./panel";
import { playerCards, userCards } from "./players";

type DbRow = Record<string, any>;
const db = () => legacyXDb();

const steamId = z.string().regex(steamIdPattern, "SteamID64 is required");
const uuid = z.string().uuid();
const reason = z.string().trim().min(1).max(240);
const durationSchema = z.union([
  z.object({ permanent: z.literal(true) }),
  z.object({ permanent: z.literal(false), minutes: z.number().int().min(1).max(maxDurationMinutes) }),
]);
const listSchema = z.object({
  status: z.enum(["active", "all", "revoked", "expired"]).default("active"),
  q: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

async function punishmentList(table: "bans" | "mutes", query: z.infer<typeof listSchema>, extra?: (q: any) => any) {
  const now = new Date().toISOString();
  let request = db().from(table).select("*", { count: "exact" }).order("created_at", { ascending: false }).range(query.offset, query.offset + query.limit - 1);
  if (query.status === "active") request = request.is("revoked_at", null).or(`is_permanent.eq.true,expires_at.gt.${now}`);
  if (query.status === "revoked") request = request.not("revoked_at", "is", null);
  if (query.status === "expired") request = request.is("revoked_at", null).eq("is_permanent", false).lte("expires_at", now);
  if (query.q && /^\d{17}$/.test(query.q)) request = request.eq("steam_id", query.q);
  if (extra) request = extra(request);
  const { data, error, count } = await request;
  legacyXError(error, `Unable to load ${table}`);
  const rows = ((data ?? []) as DbRow[]).map(row => ({ ...row, _type: table === "bans" ? "ban" : "mute" }) as DbRow);
  const [people, players] = await Promise.all([userCards(rows.flatMap(row => [row.issued_by, row.revoked_by])), playerCards(rows.map(row => row.steam_id))]);
  return { total: count ?? 0, items: rows.map(row => ({ ...mapPunishment(row, people), player: players.get(row.steam_id) })) };
}

/** Whether the actor could revoke each ban, so the panel can hide buttons it would refuse anyway. */
function withBanRights(items: ReturnType<typeof mapPunishment>[], rows: DbRow[], actor: Principal) {
  const byId = new Map(rows.map(row => [row.id, row]));
  return items.map(item => {
    const row = byId.get(item.id);
    const denial = row ? checkRevokeBan(actor, { issuedBy: row.issued_by, issuerImmunity: row.issuer_immunity, isPermanent: row.is_permanent, expiresAt: row.expires_at ? new Date(row.expires_at) : null, revokedAt: row.revoked_at ? new Date(row.revoked_at) : null }) : "unknown";
    return { ...item, canRevoke: !denial };
  });
}

export function createModerationRouter() {
  const router = Router();

  /* Kick */
  router.post("/admin/players/:steamId/kick", adminRoute("players.kick", async (req, res, actor) => {
    const input = z.object({ reason }).strict().parse(req.body);
    const result = await kickPlayer(actor, steamId.parse(req.params.steamId), input.reason, { source: "panel" });
    res.status(202).json({ ok: true, ...result });
  }));

  /* Bans */
  router.get("/admin/bans", adminRoute("bans.view", async (req, res, actor) => {
    const query = listSchema.parse(req.query);
    const list = await punishmentList("bans", query);
    const { data } = await db().from("bans").select("id,issued_by,issuer_immunity,is_permanent,expires_at,revoked_at").in("id", list.items.map(item => item.id));
    res.json({ total: list.total, items: withBanRights(list.items, (data ?? []) as DbRow[], actor) });
  }));

  router.post("/admin/bans", adminRoute("bans.issue", async (req, res, actor) => {
    const input = z.object({ steamId, reason, duration: durationSchema }).strict().parse(req.body);
    const ban = await issueBan(actor, input.steamId, input.reason, input.duration as Duration, { source: "panel" });
    res.status(201).json({ id: ban.id, reviewStatus: ban.review_status });
  }));

  router.patch("/admin/bans/:banId", adminRoute("bans.view", async (req, res, actor) => {
    const input = z.object({ duration: durationSchema }).strict().parse(req.body);
    const ban = await changeBanDuration(actor, uuid.parse(req.params.banId), input.duration as Duration);
    res.json({ id: ban.id, permanent: ban.is_permanent, expiresAt: ban.expires_at, reviewStatus: ban.review_status });
  }));

  router.post("/admin/bans/:banId/revoke", adminRoute("bans.revoke", async (req, res, actor) => {
    const input = z.object({ reason }).strict().parse(req.body);
    await revokeBan(actor, uuid.parse(req.params.banId), input.reason);
    res.json({ ok: true });
  }));

  /* Review queue: permanent bans from below manager rank */
  router.get("/admin/review-queue", adminRoute("bans.review", async (req, res) => {
    const query = listSchema.parse({ ...req.query, status: "all" });
    res.json(await punishmentList("bans", query, request => request.eq("review_status", "pending")));
  }));

  router.post("/admin/review-queue/:banId", adminRoute("bans.review", async (req, res, actor) => {
    const input = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
    await reviewBan(actor, uuid.parse(req.params.banId), input.decision, input.note ?? null);
    res.json({ ok: true });
  }));

  /* Mutes */
  router.get("/admin/mutes", adminRoute("mutes.view", async (req, res) => {
    res.json(await punishmentList("mutes", listSchema.parse(req.query)));
  }));

  router.post("/admin/mutes", adminRoute("mutes.issue", async (req, res, actor) => {
    const input = z.object({ steamId, kind: z.enum(["voice", "chat", "all"]).default("all"), reason, duration: durationSchema }).strict().parse(req.body);
    const mute = await issueMute(actor, input.steamId, input.kind, input.reason, input.duration as Duration, { source: "panel" });
    res.status(201).json({ id: mute.id });
  }));

  router.post("/admin/mutes/:muteId/revoke", adminRoute("mutes.revoke", async (req, res, actor) => {
    const input = z.object({ reason }).strict().parse(req.body);
    await revokeMute(actor, uuid.parse(req.params.muteId), input.reason);
    res.json({ ok: true });
  }));

  /* Appeals */
  router.get("/admin/appeals", adminRoute("appeals.view", async (req, res) => {
    const status = z.enum(["open", "accepted", "rejected", "all"]).default("open").parse(req.query.status);
    let query = db().from("ban_appeals").select("*,bans(*)").order("created_at", { ascending: false }).limit(100);
    if (status !== "all") query = query.eq("status", status);
    const { data, error } = await query;
    legacyXError(error, "Unable to load appeals");
    const rows = (data ?? []) as DbRow[];
    const [players, people] = await Promise.all([
      playerCards(rows.map(row => row.steam_id)),
      userCards(rows.flatMap(row => [row.handled_by, (Array.isArray(row.bans) ? row.bans[0] : row.bans)?.issued_by])),
    ]);
    res.json({ items: rows.map(row => {
      const ban = Array.isArray(row.bans) ? row.bans[0] : row.bans;
      return { id: row.id, player: players.get(row.steam_id), message: row.message, status: row.status, response: row.response, handledBy: people.get(row.handled_by) ?? null, handledAt: row.handled_at, createdAt: row.created_at, ban: ban ? mapPunishment({ ...ban, _type: "ban" }, people) : null };
    }) });
  }));

  router.post("/admin/appeals/:appealId", adminRoute("appeals.handle", async (req, res, actor) => {
    const input = z.object({ decision: z.enum(["accept", "reject"]), response: z.string().trim().max(1000).optional() }).strict().parse(req.body);
    const appealId = uuid.parse(req.params.appealId);
    const { data: appeal, error } = await db().from("ban_appeals").select("*").eq("id", appealId).maybeSingle();
    legacyXError(error, "Unable to load the appeal");
    if (!appeal) apiError(404, "Appeal was not found");
    if (appeal.status !== "open") apiError(409, "This appeal was already handled");
    // Accepting lifts the ban and therefore follows the revoke rules.
    if (input.decision === "accept") await revokeBan(actor, appeal.ban_id, input.response || "Appeal accepted", "bans.revoke.appeal");
    const { error: updateError } = await db().from("ban_appeals").update({
      status: input.decision === "accept" ? "accepted" : "rejected", handled_by: actor.userId, handled_at: new Date().toISOString(), response: input.response ?? null,
    }).eq("id", appealId).eq("status", "open");
    legacyXError(updateError, "Unable to update the appeal");
    await writeAudit(actor, { action: `appeals.${input.decision}`, targetType: "appeal", targetId: appealId, targetSteamId: appeal.steam_id, metadata: { banId: appeal.ban_id } });
    res.json({ ok: true });
  }));

  /** A banned player's own appeal. */
  router.get("/appeals/me", userRoute(async (_req, res, user) => {
    const ban = await activeBan(user.steamId);
    if (!ban) { res.json({ ban: null, appeal: null }); return; }
    const { data, error } = await db().from("ban_appeals").select("id,status,response,created_at").eq("ban_id", ban.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    legacyXError(error, "Unable to load your appeal");
    res.json({ ban: { id: ban.id, reason: ban.reason, permanent: ban.is_permanent, expiresAt: ban.expires_at }, appeal: data ?? null });
  }));

  router.post("/appeals", userRoute(async (req, res, user) => {
    const input = z.object({ message: z.string().trim().min(10).max(2000) }).strict().parse(req.body);
    const ban = await activeBan(user.steamId);
    if (!ban) apiError(404, "You have no active ban to appeal");
    const { data: previous } = await db().from("ban_appeals").select("status").eq("ban_id", ban.id);
    if ((previous ?? []).some((row: DbRow) => row.status === "rejected")) apiError(409, "This ban's appeal was already rejected");
    const { data, error } = await db().from("ban_appeals").insert({ ban_id: ban.id, steam_id: user.steamId, message: input.message }).select("id").single();
    if (error?.code === "23505") apiError(409, "You already have an open appeal");
    legacyXError(error, "Unable to submit the appeal");
    res.status(201).json({ id: data!.id });
  }));

  /* Reports */
  router.get("/admin/reports", adminRoute("reports.view", async (req, res, actor) => {
    const input = z.object({
      status: z.enum(["open", "actioned", "dismissed", "all"]).default("open"),
      serverId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    let query = db().from("reports").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(input.offset, input.offset + input.limit - 1);
    if (input.status !== "all") query = query.eq("status", input.status);
    if (input.serverId) query = query.eq("server_id", input.serverId);
    const { data, error, count } = await query;
    legacyXError(error, "Unable to load reports");
    res.json({ total: count ?? 0, items: await mapReports((data ?? []) as DbRow[], actor), canSeeReporter: can(actor, "reports.reporter.view") });
  }));

  router.post("/admin/reports/:reportId", adminRoute("reports.handle", async (req, res, actor) => {
    const input = z.object({ status: z.enum(["actioned", "dismissed"]), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
    const reportId = uuid.parse(req.params.reportId);
    const { data, error } = await db().from("reports")
      .update({ status: input.status, handled_by: actor.userId, handled_at: new Date().toISOString(), outcome_note: input.note ?? null })
      .eq("id", reportId).eq("status", "open").select("id,target_steam_id,server_id").maybeSingle();
    legacyXError(error, "Unable to update the report");
    if (!data) apiError(409, "This report was already handled");
    await writeAudit(actor, { action: `reports.${input.status}`, targetType: "report", targetId: reportId, targetSteamId: data.target_steam_id, serverId: data.server_id, metadata: { note: input.note ?? null } });
    res.json({ ok: true });
  }));

  /* Audit */
  router.get("/admin/audit", adminRoute("audit.view", async (req, res) => {
    const input = z.object({
      action: z.string().trim().max(64).regex(/^[a-z0-9_.]+$/).optional(),
      actor: z.string().regex(steamIdPattern).optional(),
      target: z.string().regex(steamIdPattern).optional(),
      beforeId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    let query = db().from("admin_audit_logs").select("*").order("id", { ascending: false }).limit(input.limit);
    if (input.action) query = query.like("action", `${input.action}%`);
    if (input.actor) query = query.eq("actor_steam_id", input.actor);
    if (input.target) query = query.eq("target_steam_id", input.target);
    if (input.beforeId) query = query.lt("id", input.beforeId);
    const { data, error } = await query;
    legacyXError(error, "Unable to load the audit log");
    res.json({ items: await mapAuditRows((data ?? []) as DbRow[]) });
  }));

  return router;
}

