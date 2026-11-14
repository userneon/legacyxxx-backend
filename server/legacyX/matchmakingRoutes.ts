/**
 * The matchmaking queue's routes and its ticker (see matchmaking.ts for the rules). The tables are in supabase/legacy_x_matchmaking.sql.
 *
 *   POST /queue/join {mode}   enter the queue (banned players and players blocked for leaving matches are refused; Pro League needs the rank)
 *   POST /queue/leave         leave the queue, or decline a found match
 *   POST /queue/accept        press Accept on a found match
 *   GET  /queue/status        idle | queued | found | ready, with the numbers the Play page shows, plus `party` and `invitations`
 *   GET  /party, POST /party/invite|accept|decline|leave|kick   a party of up to five that queues together (the leader presses Find match; the party shares one team)
 *
 * A ticker (every 3 s) builds lobbies, cancels matches nobody accepted, hands accepted matches to a free game server as a `match_load` server action
 * (the plugin writes the MatchZy file and loads it) and closes matches that are over. Real rows only: nothing here is invented.
 */
import { randomUUID } from "node:crypto";
import type { Router } from "express";
import { z } from "zod";

import { activeBannedUserIds } from "./bans";
import { ACCEPT_SECONDS, MAP_POOL, MATCH_SIZE, PARTY_MAX, buildMatchZyConfig, pickLobby, pickMap, pickServerForMatch, splitTeams, type LobbyPlayer, type QueueEntry, type QueueMode } from "./matchmaking";
import { leaveRulesFrom, leaveStatus, loadLeaves } from "./playAccess";
import type { PlayServer } from "./play";
import { loadSettings } from "./settings";
import { legacyXError } from "./supabase";

type Row = Record<string, any>;

interface Deps {
  router: Router;
  db: () => any;
  userRoute: (handler: (req: any, res: any, user: { id: string; steamId: string; username: string }) => Promise<void>) => any;
  apiError: (status: number, message: string) => never;
  loadPlayServers: () => Promise<Array<PlayServer>>;
  wakeServer: (serverId: string) => void;
}

const MODES: QueueMode[] = ["5x5", "pro"];
const text = (value: unknown) => (typeof value === "string" ? value : "");
const SERVER_WAIT_MS = 120_000;
const LOAD_TIMEOUT_MS = 5 * 60_000;
const MATCH_MAX_MS = 3 * 60 * 60_000;

export function registerMatchmakingRoutes(deps: Deps) {
  const { router, db, userRoute, apiError, loadPlayServers, wakeServer } = deps;
  let ticking = false;

  /** Players in each queue right now. */
  const queueCounts = async () => {
    const { data, error } = await db().from("queue_entries").select("mode");
    legacyXError(error, "Unable to read the queue");
    const counts: Record<string, number> = { "5x5": 0, pro: 0 };
    for (const row of (data ?? []) as Row[]) counts[text(row.mode)] = (counts[text(row.mode)] ?? 0) + 1;
    return counts;
  };

  /** Matches that have a server right now (loading or being played). */
  const liveMatchCount = async () => {
    const { count } = await db().from("queue_matches").select("id", { count: "exact", head: true }).in("status", ["loading", "live"]);
    return count ?? 0;
  };

  const cancelMatch = async (matchId: string, requeueAccepted: boolean) => {
    const { data: players } = await db().from("queue_match_players").select("user_id,exp,joined_at,accepted,party_id").eq("match_id", matchId);
    const { data: match } = await db().from("queue_matches").select("mode").eq("id", matchId).maybeSingle();
    await db().from("queue_matches").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", matchId);
    if (requeueAccepted && match) {
      const back = ((players ?? []) as Row[]).filter((player) => player.accepted).map((player) => ({ user_id: player.user_id, mode: match.mode, exp: player.exp, joined_at: player.joined_at, party_id: player.party_id ?? null }));
      if (back.length > 0) await db().from("queue_entries").upsert(back, { onConflict: "user_id" });
    }
  };

  const tickMode = async (mode: QueueMode, servers: PlayServer[], now: number) => {
    // 1. Matches nobody (or not everybody) accepted in time; or all accepted but no server came in time.
    const { data: open } = await db().from("queue_matches").select("id,status,accept_deadline,created_at").eq("mode", mode).in("status", ["accepting", "loading", "live"]);
    const busy = new Set<string>();
    for (const match of (open ?? []) as Row[]) {
      const id = text(match.id);
      const age = now - Date.parse(text(match.created_at));
      if (match.status === "accepting") {
        const { data: players } = await db().from("queue_match_players").select("accepted").eq("match_id", id);
        const accepted = ((players ?? []) as Row[]).filter((player) => player.accepted).length;
        const deadline = Date.parse(text(match.accept_deadline));
        if (accepted < MATCH_SIZE && now >= deadline) await cancelMatch(id, true);
        else if (accepted >= MATCH_SIZE && now >= deadline + SERVER_WAIT_MS) await cancelMatch(id, true);
        else if (accepted >= MATCH_SIZE) await assignServer(id, mode, servers, busy);
      } else {
        const { data: row } = await db().from("queue_matches").select("server_id,started_at").eq("id", id).maybeSingle();
        const serverId = text(row?.server_id);
        const server = servers.find((candidate) => candidate.id === serverId);
        if (serverId) busy.add(serverId);
        if (age > MATCH_MAX_MS) await db().from("queue_matches").update({ status: "finished", finished_at: new Date(now).toISOString() }).eq("id", id);
        else if (match.status === "loading" && server?.status === "live") await db().from("queue_matches").update({ status: "live", started_at: new Date(now).toISOString() }).eq("id", id);
        else if (match.status === "loading" && age > LOAD_TIMEOUT_MS && server?.status !== "live") await cancelMatch(id, false);
        else if (match.status === "live" && server && server.players === 0 && age > 3 * 60_000) await db().from("queue_matches").update({ status: "finished", finished_at: new Date(now).toISOString() }).eq("id", id);
      }
    }
    // 2. A lobby from the queue.
    for (;;) {
      const { data: rows } = await db().from("queue_entries").select("user_id,exp,joined_at,party_id").eq("mode", mode);
      const entries = (rows ?? []) as Row[];
      if (entries.length < MATCH_SIZE) return;
      const { data: users } = await db().from("users").select("id,steam_id,username").in("id", entries.map((entry) => entry.user_id));
      const byId = new Map(((users ?? []) as Row[]).map((user) => [text(user.id), user]));
      const queue: QueueEntry[] = entries.flatMap((entry) => {
        const user = byId.get(text(entry.user_id));
        return user ? [{ userId: text(entry.user_id), steamId: text(user.steam_id), username: text(user.username) || "Player", exp: Number(entry.exp) || 0, joinedAt: Date.parse(text(entry.joined_at)), partyId: text(entry.party_id) || null }] : [];
      });
      const lobby = pickLobby(queue, now);
      if (!lobby) return;
      const teams = splitTeams(lobby);
      const matchId = randomUUID();
      const map = pickMap();
      const { error } = await db().from("queue_matches").insert({ id: matchId, mode, map, status: "accepting", accept_deadline: new Date(now + ACCEPT_SECONDS * 1000).toISOString() });
      legacyXError(error, "Unable to create a match");
      await db().from("queue_match_players").insert(teams.map((player) => ({ match_id: matchId, user_id: player.userId, steam_id: player.steamId, username: player.username, team: player.team, exp: player.exp, joined_at: new Date(player.joinedAt).toISOString(), party_id: player.partyId ?? null, accepted: false })));
      await db().from("queue_entries").delete().in("user_id", teams.map((player) => player.userId));
    }
  };

  /** All ten accepted: give the match an empty server and send it the match file. */
  const assignServer = async (matchId: string, mode: QueueMode, servers: PlayServer[], busy: Set<string>) => {
    const { data: held } = await db().from("queue_matches").select("server_id").in("status", ["loading", "live"]);
    for (const row of (held ?? []) as Row[]) if (row.server_id) busy.add(text(row.server_id));
    const server = pickServerForMatch(servers, mode, busy);
    if (!server) return;
    const { data: match } = await db().from("queue_matches").select("map").eq("id", matchId).maybeSingle();
    const { data: rows } = await db().from("queue_match_players").select("user_id,steam_id,username,team,exp,joined_at").eq("match_id", matchId);
    const players: LobbyPlayer[] = ((rows ?? []) as Row[]).map((row) => ({ userId: text(row.user_id), steamId: text(row.steam_id), username: text(row.username), exp: Number(row.exp) || 0, joinedAt: Date.parse(text(row.joined_at)), team: row.team === 2 ? 2 : 1 }));
    const map = text(match?.map) || pickMap();
    const config = buildMatchZyConfig(matchId, map, players);
    // Claim the match first so a second tick cannot give it a second server.
    const { data: claimed } = await db().from("queue_matches").update({ status: "loading", server_id: server.id, connect_address: server.connectAddress }).eq("id", matchId).eq("status", "accepting").select("id");
    if (!claimed || claimed.length === 0) return;
    busy.add(server.id);
    const { error } = await db().from("staff_panel_actions").insert({ server_id: server.id, requested_by: players[0].userId, action_type: "match_load", payload: { type: "match_load", serverId: server.id, matchId, map, config }, status: "pending" });
    if (error) { await db().from("queue_matches").update({ status: "accepting", server_id: null, connect_address: null }).eq("id", matchId); throw error; }
    wakeServer(server.id);
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const servers = await loadPlayServers();
      const now = Date.now();
      for (const mode of MODES) await tickMode(mode, servers, now);
    } catch (error) {
      console.error("[legacy-x-api] Matchmaking tick failed", error);
    } finally {
      ticking = false;
    }
  };
  setInterval(() => { void tick(); }, 3000).unref();

  interface PartyMember { userId: string; username: string; avatar: string; exp: number }
  interface Party { id: string; leaderId: string; members: PartyMember[] }

  /** The party a player is in (with its members), or null. */
  const myParty = async (userId: string): Promise<Party | null> => {
    const { data: mine } = await db().from("party_members").select("party_id").eq("user_id", userId).maybeSingle();
    if (!mine) return null;
    const { data: party } = await db().from("parties").select("id,leader_id").eq("id", mine.party_id).maybeSingle();
    if (!party) return null;
    const { data: rows } = await db().from("party_members").select("user_id,joined_at").eq("party_id", party.id).order("joined_at", { ascending: true });
    const ids = ((rows ?? []) as Row[]).map((row) => text(row.user_id));
    const { data: users } = await db().from("users").select("id,username,avatar").in("id", ids);
    const { data: profiles } = await db().from("competitive_player_profiles").select("user_id,current_exp").in("user_id", ids);
    const name = new Map(((users ?? []) as Row[]).map((user) => [text(user.id), text(user.username) || "Player"]));
    const avatar = new Map(((users ?? []) as Row[]).map((user) => [text(user.id), text(user.avatar)]));
    const exp = new Map(((profiles ?? []) as Row[]).map((row) => [text(row.user_id), Number(row.current_exp) || 0]));
    return { id: text(party.id), leaderId: text(party.leader_id), members: ids.map((id) => ({ userId: id, username: name.get(id) ?? "Player", avatar: avatar.get(id) ?? "", exp: exp.get(id) ?? 0 })) };
  };

  /** What the Play page shows about parties: my party (members, who I invited) and the invitations waiting for me. */
  const partyView = async (userId: string) => {
    const party = await myParty(userId);
    let invited: Array<{ userId: string; username: string; avatar: string }> = [];
    if (party) {
      const { data: invites } = await db().from("party_invites").select("user_id").eq("party_id", party.id);
      const ids = ((invites ?? []) as Row[]).map((row) => text(row.user_id));
      if (ids.length > 0) {
        const { data: users } = await db().from("users").select("id,username,avatar").in("id", ids);
        invited = ((users ?? []) as Row[]).map((user) => ({ userId: text(user.id), username: text(user.username) || "Player", avatar: text(user.avatar) }));
      }
    }
    const { data: mine } = await db().from("party_invites").select("party_id,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(10);
    const invitations: Array<{ partyId: string; from: string }> = [];
    for (const row of (mine ?? []) as Row[]) {
      const { data: owner } = await db().from("parties").select("leader_id").eq("id", row.party_id).maybeSingle();
      const { data: leader } = owner ? await db().from("users").select("username").eq("id", owner.leader_id).maybeSingle() : { data: null };
      if (leader) invitations.push({ partyId: text(row.party_id), from: text(leader.username) || "Player" });
    }
    return { party: party ? { ...party, invited } : null, invitations };
  };

  /** Take a player out of their party (the leader's seat goes to the longest member; an empty party is deleted) and out of any queue the party was in. */
  const leaveParty = async (userId: string) => {
    const party = await myParty(userId);
    if (!party) return;
    await db().from("party_members").delete().eq("user_id", userId);
    await db().from("queue_entries").delete().eq("user_id", userId);
    if (party.members.length > 1) await db().from("queue_entries").delete().eq("party_id", party.id);
    const rest = party.members.filter((member) => member.userId !== userId);
    if (rest.length === 0) await db().from("parties").delete().eq("id", party.id);
    else if (party.leaderId === userId) await db().from("parties").update({ leader_id: rest[0].userId }).eq("id", party.id);
  };

  const userIdSchema = z.object({ userId: z.string().uuid() });

  router.get("/party", userRoute(async (_req, res, user) => {
    res.set("Cache-Control", "no-store");
    res.json(await partyView(user.id));
  }));

  router.post("/party/invite", userRoute(async (req, res, user) => {
    const { userId } = userIdSchema.parse(req.body);
    if (userId === user.id) apiError(400, "You cannot invite yourself.");
    const { data: target } = await db().from("users").select("id").eq("id", userId).maybeSingle();
    if (!target) apiError(404, "Player not found.");
    if ((await activeBannedUserIds(db(), [userId])).has(userId)) apiError(403, "That player is banned.");
    let party = await myParty(user.id);
    if (party && party.leaderId !== user.id) apiError(403, "Only the party leader can invite.");
    if (party?.members.some((member) => member.userId === userId)) apiError(409, "That player is already in your party.");
    if (!party) {
      const partyId = randomUUID();
      const { error: createError } = await db().from("parties").insert({ id: partyId, leader_id: user.id });
      legacyXError(createError, "Unable to create a party");
      const { error: memberError } = await db().from("party_members").insert({ party_id: partyId, user_id: user.id });
      legacyXError(memberError, "Unable to create a party");
      party = { id: partyId, leaderId: user.id, members: [{ userId: user.id, username: user.username, avatar: "", exp: 0 }] };
    }
    const { data: invites } = await db().from("party_invites").select("user_id").eq("party_id", party.id);
    if (party.members.length + (invites ?? []).length >= PARTY_MAX) apiError(409, `A party holds ${PARTY_MAX} players.`);
    const { error } = await db().from("party_invites").upsert({ party_id: party.id, user_id: userId, invited_by: user.id }, { onConflict: "party_id,user_id" });
    legacyXError(error, "Unable to invite");
    res.status(201).json({ ok: true });
  }));

  router.post("/party/accept", userRoute(async (req, res, user) => {
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(req.body);
    const { data: invite } = await db().from("party_invites").select("party_id").eq("party_id", partyId).eq("user_id", user.id).maybeSingle();
    if (!invite) apiError(404, "That invitation is gone.");
    const { data: queued } = await db().from("queue_entries").select("user_id").eq("user_id", user.id).maybeSingle();
    if (queued) apiError(409, "Leave the queue before joining a party.");
    const { data: members } = await db().from("party_members").select("user_id").eq("party_id", partyId);
    if ((members ?? []).length === 0) { await db().from("party_invites").delete().eq("party_id", partyId); apiError(404, "That party no longer exists."); }
    if ((members ?? []).length >= PARTY_MAX) apiError(409, "That party is full.");
    await leaveParty(user.id);
    const { error } = await db().from("party_members").insert({ party_id: partyId, user_id: user.id });
    legacyXError(error, "Unable to join the party");
    await db().from("party_invites").delete().eq("user_id", user.id);
    res.json({ ok: true });
  }));

  router.post("/party/decline", userRoute(async (req, res, user) => {
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(req.body);
    await db().from("party_invites").delete().eq("party_id", partyId).eq("user_id", user.id);
    res.json({ ok: true });
  }));

  router.post("/party/leave", userRoute(async (_req, res, user) => {
    await leaveParty(user.id);
    res.json({ ok: true });
  }));

  router.post("/party/kick", userRoute(async (req, res, user) => {
    const { userId } = userIdSchema.parse(req.body);
    const party = await myParty(user.id);
    if (!party || party.leaderId !== user.id) return apiError(403, "Only the party leader can remove players.");
    if (userId === user.id) apiError(400, "Use Leave party instead.");
    // Withdraw a pending invitation too.
    await db().from("party_invites").delete().eq("party_id", party.id).eq("user_id", userId);
    if (party.members.some((member) => member.userId === userId)) await leaveParty(userId);
    res.json({ ok: true });
  }));

  const modeSchema = z.object({ mode: z.enum(["5x5", "pro"]) });

  router.post("/queue/join", userRoute(async (req, res, user) => {
    const { mode } = modeSchema.parse(req.body);
    const now = new Date();
    if ((await activeBannedUserIds(db(), [user.id])).has(user.id)) apiError(403, "You are banned and cannot queue.");
    const rules = leaveRulesFrom(await loadSettings(db()));
    const status = leaveStatus((await loadLeaves(db(), [user.id], now, rules.windowMs)).get(user.id) ?? [], now, rules);
    if (status.cooldown) apiError(403, `You left a match too often. You can queue again in ${Math.ceil((Date.parse(status.cooldown.until) - now.getTime()) / 60_000)} minutes.`);
    // A party queues together, started by its leader: every member is checked and gets the same entry time.
    const party = await myParty(user.id);
    if (party && party.members.length > 1 && party.leaderId !== user.id) apiError(403, "Only the party leader can start the queue.");
    const ids = party && party.members.length > 1 ? party.members.map((member) => member.userId) : [user.id];
    const banned = await activeBannedUserIds(db(), ids);
    const leaves = await loadLeaves(db(), ids, now, rules.windowMs);
    const { data: busyRows } = await db().from("queue_match_players").select("user_id,queue_matches!inner(status)").in("user_id", ids).in("queue_matches.status", ["accepting", "loading", "live"]);
    const busy = new Set(((busyRows ?? []) as Row[]).map((row) => text(row.user_id)));
    const { data: profiles } = await db().from("competitive_player_profiles").select("user_id,current_exp,pro_league_unlocked").in("user_id", ids);
    const profileOf = new Map(((profiles ?? []) as Row[]).map((row) => [text(row.user_id), row]));
    const nameOf = new Map((party?.members ?? []).map((member) => [member.userId, member.username]));
    for (const id of ids) {
      const who = id === user.id ? "You are" : `${nameOf.get(id) ?? "A party member"} is`;
      const whoCan = id === user.id ? "You" : (nameOf.get(id) ?? "A party member");
      if (banned.has(id)) apiError(403, `${who} banned and cannot queue.`);
      const cooldown = leaveStatus(leaves.get(id) ?? [], now, rules).cooldown;
      if (cooldown) apiError(403, `${whoCan} left a match too often and can queue again in ${Math.ceil((Date.parse(cooldown.until) - now.getTime()) / 60_000)} minutes.`);
      if (busy.has(id)) apiError(409, `${who} already in a match.`);
      if (mode === "pro" && !profileOf.get(id)?.pro_league_unlocked) apiError(403, `${whoCan} need${id === user.id ? "" : "s"} a higher rank for Pro League.`);
    }
    const partyId = party && party.members.length > 1 ? party.id : null;
    const { error } = await db().from("queue_entries").upsert(ids.map((id) => ({ user_id: id, mode, exp: Number(profileOf.get(id)?.current_exp) || 0, joined_at: now.toISOString(), party_id: partyId })), { onConflict: "user_id" });
    legacyXError(error, "Unable to join the queue");
    void tick();
    res.status(201).json({ ok: true });
  }));

  router.post("/queue/leave", userRoute(async (_req, res, user) => {
    const party = await myParty(user.id);
    await db().from("queue_entries").delete().eq("user_id", user.id);
    if (party && party.members.length > 1) await db().from("queue_entries").delete().eq("party_id", party.id);
    // Declining a found match cancels it; the others who accepted go back in the queue.
    const { data } = await db().from("queue_match_players").select("match_id,queue_matches!inner(status)").eq("user_id", user.id).eq("queue_matches.status", "accepting");
    for (const row of (data ?? []) as Row[]) {
      await db().from("queue_match_players").delete().eq("match_id", row.match_id).eq("user_id", user.id);
      await cancelMatch(text(row.match_id), true);
    }
    res.json({ ok: true });
  }));

  router.post("/queue/accept", userRoute(async (req, res, user) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(req.body);
    const { data: match } = await db().from("queue_matches").select("id,status,accept_deadline").eq("id", matchId).maybeSingle();
    if (!match || match.status !== "accepting" || Date.parse(text(match.accept_deadline)) < Date.now()) apiError(409, "This match is no longer waiting for you.");
    const { data, error } = await db().from("queue_match_players").update({ accepted: true }).eq("match_id", matchId).eq("user_id", user.id).select("user_id");
    legacyXError(error, "Unable to accept");
    if (!data || data.length === 0) apiError(404, "You are not in this match.");
    void tick();
    res.json({ ok: true });
  }));

  router.get("/queue/status", userRoute(async (_req, res, user) => {
    res.set("Cache-Control", "no-store");
    const counts = await queueCounts();
    const partyInfo = await partyView(user.id);
    const liveMatches = await liveMatchCount();
    const send = (body: Record<string, unknown>) => res.json({ ...body, ...partyInfo, liveMatches, maps: MAP_POOL });
    const { data: mine } = await db().from("queue_match_players").select("match_id,team,accepted,queue_matches!inner(id,mode,map,status,accept_deadline,server_id,connect_address)").eq("user_id", user.id).in("queue_matches.status", ["accepting", "loading", "live"]).order("joined_at", { ascending: false }).limit(1);
    const row = ((mine ?? []) as Row[])[0];
    if (row) {
      const match = row.queue_matches as Row;
      const { data: players } = await db().from("queue_match_players").select("user_id,username,team,accepted,exp").eq("match_id", match.id);
      const list = (players ?? []) as Row[];
      const base = { id: text(match.id), mode: text(match.mode), map: text(match.map), acceptDeadline: text(match.accept_deadline), accepted: list.filter((player) => player.accepted).length, total: list.length, myAccepted: Boolean(row.accepted) };
      if (match.status === "accepting") {
        send({ state: base.accepted >= base.total ? "preparing" : "found", counts, match: base });
        return;
      }
      const { data: faces } = await db().from("users").select("id,avatar").in("id", list.map((player) => player.user_id));
      const face = new Map(((faces ?? []) as Row[]).map((user) => [text(user.id), text(user.avatar)]));
      send({ state: "ready", counts, match: { ...base, status: text(match.status), team: row.team === 2 ? 2 : 1, connectAddress: text(match.connect_address) || null, players: list.map((player) => ({ userId: text(player.user_id), username: text(player.username), avatar: face.get(text(player.user_id)) ?? "", team: player.team === 2 ? 2 : 1, exp: Number(player.exp) || 0 })) } });
      return;
    }
    const { data: entry } = await db().from("queue_entries").select("mode,joined_at").eq("user_id", user.id).maybeSingle();
    if (entry) {
      send({ state: "queued", counts, queue: { mode: text(entry.mode), joinedAt: text(entry.joined_at) } });
      return;
    }
    send({ state: "idle", counts });
  }));
}
