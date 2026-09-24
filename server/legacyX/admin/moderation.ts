/**
 * Moderation actions shared by the web panel and the in-game menu. Each one re-checks the rules in
 * `permissions.ts` against a freshly loaded principal and writes an audit entry.
 */
import { apiError } from "../http";
import { legacyXDb, legacyXError } from "../supabase";
import { enforce, loadPrincipalBySteamId, writeAudit } from "./context";
import {
  banNeedsReview,
  checkChangeBan,
  checkIssueBan,
  checkIssueMute,
  checkKick,
  checkRevokeBan,
  checkRevokeMute,
  checkReviewBan,
  type BanState,
  type Principal,
} from "./permissions";

type DbRow = Record<string, any>;
const db = () => legacyXDb();

export type ActionContext = { source: "panel" | "game"; serverId?: string | null; matchId?: string | null };
export type Duration = { permanent: true } | { permanent: false; minutes: number };

export const maxDurationMinutes = 60 * 24 * 365;

function expiryFor(duration: Duration, from = new Date()) {
  return duration.permanent ? null : new Date(from.getTime() + duration.minutes * 60_000);
}

function termLabel(duration: Duration) {
  if (duration.permanent) return "Permanent";
  const m = duration.minutes;
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

function toBanState(row: DbRow): BanState {
  return {
    issuedBy: row.issued_by ?? null,
    issuerImmunity: Number(row.issuer_immunity) || 0,
    isPermanent: row.is_permanent === true,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

function snapshot(row: DbRow) {
  return { is_permanent: row.is_permanent, expires_at: row.expires_at, revoked_at: row.revoked_at, review_status: row.review_status };
}

/** Mirrors a new ban or mute into the public `penalties` record (only for players with a site account). */
async function mirrorPenalty(target: Principal, actor: Principal, type: "ban" | "comm" | "gag", reason: string, duration: Duration) {
  if (!target.userId) return null;
  const { data, error } = await db().from("penalties").insert({
    user_id: target.userId,
    type,
    reason,
    term: termLabel(duration),
    is_permanent: duration.permanent,
    is_unbanned: false,
    admin_id: actor.userId || null,
    admin_name: actor.username || "Staff",
    expires_at: expiryFor(duration)?.toISOString() ?? null,
  }).select("id").single();
  legacyXError(error, "Unable to record the public penalty");
  return String(data!.id);
}

async function updateMirroredPenalty(penaltyId: string | null, patch: Record<string, unknown>) {
  if (!penaltyId) return;
  const { error } = await db().from("penalties").update(patch).eq("id", penaltyId);
  legacyXError(error, "Unable to update the public penalty");
}

async function queueGameAction(serverId: string, action: string, targetSteamId: string | null, payload: Record<string, unknown>, requestedBy: string | null) {
  const { data, error } = await db().from("admin_game_actions").insert({
    server_id: serverId, action, target_steam_id: targetSteamId, payload, requested_by: requestedBy || null,
  }).select("id").single();
  legacyXError(error, "Unable to queue the server action");
  return String(data!.id);
}

/** The server the player is on right now, from their open session. */
export async function currentServerFor(steamId: string) {
  const { data, error } = await db().from("player_sessions").select("server_id,match_id")
    .eq("steam_id", steamId).is("disconnected_at", null).order("connected_at", { ascending: false }).limit(1).maybeSingle();
  legacyXError(error, "Unable to resolve the player's server");
  return data ? { serverId: String(data.server_id), matchId: data.match_id ? String(data.match_id) : null } : null;
}

/* ---------------------------------------------------------------------------
 * Kick
 * ------------------------------------------------------------------------ */

export async function kickPlayer(actor: Principal, steamId: string, reason: string, context: ActionContext) {
  const target = await loadPrincipalBySteamId(steamId);
  enforce(checkKick(actor, target.immunity));
  const serverId = context.serverId ?? (await currentServerFor(steamId))?.serverId;
  if (!serverId) apiError(409, "The player is not on a server");
  // In-game kicks are carried out by the plugin as soon as this returns; panel kicks go through the queue.
  const actionId = context.source === "panel" ? await queueGameAction(serverId, "kick", steamId, { reason }, actor.userId) : null;
  await writeAudit(actor, { action: "players.kick", targetType: "player", targetSteamId: steamId, serverId, metadata: { reason, source: context.source, actionId } });
  return { serverId, actionId };
}

/* ---------------------------------------------------------------------------
 * Bans
 * ------------------------------------------------------------------------ */

export async function issueBan(actor: Principal, steamId: string, reason: string, duration: Duration, context: ActionContext) {
  const target = await loadPrincipalBySteamId(steamId);
  enforce(checkIssueBan(actor, target.immunity, duration.permanent));
  const penaltyId = await mirrorPenalty(target, actor, "ban", reason, duration);
  const review = banNeedsReview(actor, duration.permanent);
  const { data, error } = await db().from("bans").insert({
    steam_id: steamId,
    user_id: target.userId || null,
    reason,
    is_permanent: duration.permanent,
    expires_at: expiryFor(duration)?.toISOString() ?? null,
    issued_by: actor.userId || null,
    issuer_steam_id: actor.steamId,
    issuer_immunity: actor.immunity,
    server_id: context.serverId ?? null,
    match_id: context.matchId ?? null,
    source: context.source,
    review_status: review ? "pending" : "none",
    penalty_id: penaltyId,
  }).select("*").single();
  legacyXError(error, "Unable to issue the ban");
  const ban = data as DbRow;

  // Remove the player from wherever they are playing now.
  const live = context.source === "panel" ? await currentServerFor(steamId) : null;
  if (live) await queueGameAction(live.serverId, "ban", steamId, { reason, banId: ban.id }, actor.userId);

  await writeAudit(actor, {
    action: duration.permanent ? "bans.permanent.issue" : "bans.issue",
    targetType: "ban", targetId: String(ban.id), targetSteamId: steamId, serverId: context.serverId ?? live?.serverId ?? null,
    after: snapshot(ban), metadata: { reason, source: context.source, review },
  });
  return ban;
}

async function loadBan(banId: string) {
  const { data, error } = await db().from("bans").select("*").eq("id", banId).maybeSingle();
  legacyXError(error, "Unable to load the ban");
  if (!data) apiError(404, "Ban was not found");
  return data as DbRow;
}

export async function revokeBan(actor: Principal, banId: string, reason: string, action = "bans.revoke") {
  const ban = await loadBan(banId);
  enforce(checkRevokeBan(actor, toBanState(ban)));
  const now = new Date().toISOString();
  const { data, error } = await db().from("bans")
    .update({ revoked_at: now, revoked_by: actor.userId, revoke_reason: reason })
    .eq("id", banId).is("revoked_at", null).select("*").maybeSingle();
  legacyXError(error, "Unable to revoke the ban");
  if (!data) apiError(409, "Ban was already revoked");
  await updateMirroredPenalty(ban.penalty_id, { is_unbanned: true });
  await writeAudit(actor, { action, targetType: "ban", targetId: banId, targetSteamId: ban.steam_id, before: snapshot(ban), after: snapshot(data), metadata: { reason } });
  return data as DbRow;
}

export async function changeBanDuration(actor: Principal, banId: string, duration: Duration) {
  const ban = await loadBan(banId);
  const target = await loadPrincipalBySteamId(ban.steam_id);
  // The new length counts from the original issue time, so "7d" means seven days from when it was issued.
  const expiresAt = expiryFor(duration, new Date(ban.created_at));
  if (expiresAt && expiresAt.getTime() <= Date.now()) apiError(400, "That duration has already passed; revoke the ban instead");
  enforce(checkChangeBan(actor, toBanState(ban), { isPermanent: duration.permanent, expiresAt }, target.immunity));
  const patch: Record<string, unknown> = { is_permanent: duration.permanent, expires_at: expiresAt?.toISOString() ?? null };
  if (duration.permanent && !ban.is_permanent && banNeedsReview(actor, true)) patch.review_status = "pending";
  if (!duration.permanent && ban.review_status === "pending") patch.review_status = "none";
  const { data, error } = await db().from("bans").update(patch).eq("id", banId).select("*").single();
  legacyXError(error, "Unable to change the ban");
  await updateMirroredPenalty(ban.penalty_id, { is_permanent: duration.permanent, expires_at: patch.expires_at, term: termLabel(duration) });
  await writeAudit(actor, { action: "bans.change", targetType: "ban", targetId: banId, targetSteamId: ban.steam_id, before: snapshot(ban), after: snapshot(data) });
  return data as DbRow;
}

export async function reviewBan(actor: Principal, banId: string, decision: "approve" | "reject", note: string | null) {
  enforce(checkReviewBan(actor));
  const ban = await loadBan(banId);
  if (ban.review_status !== "pending") apiError(409, "This ban is not waiting for review");
  if (decision === "reject") {
    // Rejecting lifts the ban, so it must also pass the revoke rules.
    enforce(checkRevokeBan(actor, toBanState(ban)));
  }
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { review_status: decision === "approve" ? "approved" : "rejected", reviewed_by: actor.userId, reviewed_at: now, review_note: note };
  if (decision === "reject") Object.assign(patch, { revoked_at: now, revoked_by: actor.userId, revoke_reason: note ?? "Rejected in review" });
  const { data, error } = await db().from("bans").update(patch).eq("id", banId).eq("review_status", "pending").select("*").maybeSingle();
  legacyXError(error, "Unable to review the ban");
  if (!data) apiError(409, "This ban was already reviewed");
  if (decision === "reject") await updateMirroredPenalty(ban.penalty_id, { is_unbanned: true });
  await writeAudit(actor, { action: `bans.review.${decision}`, targetType: "ban", targetId: banId, targetSteamId: ban.steam_id, before: snapshot(ban), after: snapshot(data), metadata: { note } });
  return data as DbRow;
}

/* ---------------------------------------------------------------------------
 * Mutes
 * ------------------------------------------------------------------------ */

export type MuteKind = "voice" | "chat" | "all";

export async function issueMute(actor: Principal, steamId: string, kind: MuteKind, reason: string, duration: Duration, context: ActionContext) {
  const target = await loadPrincipalBySteamId(steamId);
  enforce(checkIssueMute(actor, target.immunity));
  const penaltyId = await mirrorPenalty(target, actor, kind === "chat" ? "gag" : "comm", reason, duration);
  const { data, error } = await db().from("mutes").insert({
    steam_id: steamId,
    user_id: target.userId || null,
    kind,
    reason,
    is_permanent: duration.permanent,
    expires_at: expiryFor(duration)?.toISOString() ?? null,
    issued_by: actor.userId || null,
    issuer_steam_id: actor.steamId,
    issuer_immunity: actor.immunity,
    server_id: context.serverId ?? null,
    match_id: context.matchId ?? null,
    source: context.source,
    penalty_id: penaltyId,
  }).select("*").single();
  legacyXError(error, "Unable to mute the player");
  const mute = data as DbRow;
  const live = context.source === "panel" ? await currentServerFor(steamId) : null;
  if (live) await queueGameAction(live.serverId, "mute", steamId, { kind, reason, muteId: mute.id, expiresAt: mute.expires_at }, actor.userId);
  await writeAudit(actor, { action: "mutes.issue", targetType: "mute", targetId: String(mute.id), targetSteamId: steamId, serverId: context.serverId ?? live?.serverId ?? null, after: snapshot(mute), metadata: { reason, kind, source: context.source } });
  return mute;
}

export async function revokeMute(actor: Principal, muteId: string, reason: string, context: ActionContext = { source: "panel" }) {
  const { data: mute, error: loadError } = await db().from("mutes").select("*").eq("id", muteId).maybeSingle();
  legacyXError(loadError, "Unable to load the mute");
  if (!mute) apiError(404, "Mute was not found");
  enforce(checkRevokeMute(actor, toBanState(mute)));
  const { data, error } = await db().from("mutes")
    .update({ revoked_at: new Date().toISOString(), revoked_by: actor.userId || null, revoke_reason: reason })
    .eq("id", muteId).is("revoked_at", null).select("*").maybeSingle();
  legacyXError(error, "Unable to lift the mute");
  if (!data) apiError(409, "Mute was already lifted");
  await updateMirroredPenalty(mute.penalty_id, { is_unbanned: true });
  const live = context.source === "panel" ? await currentServerFor(mute.steam_id) : null;
  if (live) await queueGameAction(live.serverId, "unmute", mute.steam_id, { muteId }, actor.userId);
  await writeAudit(actor, { action: "mutes.revoke", targetType: "mute", targetId: muteId, targetSteamId: mute.steam_id, before: snapshot(mute), after: snapshot(data), metadata: { reason, source: context.source } });
  return data as DbRow;
}

/* ---------------------------------------------------------------------------
 * Enforcement lookups
 * ------------------------------------------------------------------------ */

const activeFilter = (now: string) => `is_permanent.eq.true,expires_at.gt.${now}`;

export async function activeBan(steamId: string) {
  const now = new Date().toISOString();
  const { data, error } = await db().from("bans").select("id,reason,is_permanent,expires_at")
    .eq("steam_id", steamId).is("revoked_at", null).or(activeFilter(now)).order("created_at", { ascending: false }).limit(1).maybeSingle();
  legacyXError(error, "Unable to check bans");
  return data as DbRow | null;
}

export async function activeMute(steamId: string) {
  const now = new Date().toISOString();
  const { data, error } = await db().from("mutes").select("id,kind,reason,is_permanent,expires_at")
    .eq("steam_id", steamId).is("revoked_at", null).or(activeFilter(now)).order("created_at", { ascending: false }).limit(1).maybeSingle();
  legacyXError(error, "Unable to check mutes");
  return data as DbRow | null;
}

export { queueGameAction };
