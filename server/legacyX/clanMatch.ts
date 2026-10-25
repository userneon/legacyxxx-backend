import type { SupabaseClient } from "@supabase/supabase-js";

import { LEVEL_PERKS, WAR_XP, levelFor, matchXp, warRatingChange, warSides } from "./clanProgress";

type Db = SupabaseClient<any, any, any, any, any>;
type Row = Record<string, any>;

/** How long around the agreed time a match between the two clans still settles their war. */
export const WAR_WINDOW_BEFORE_MS = 60 * 60_000;
export const WAR_WINDOW_AFTER_MS = 6 * 60 * 60_000;

type FinishedPlayer = { userId: string; team: string; outcome: "win" | "draw" | "loss"; breakdown: { rule?: string } };

const tell = async (db: Db, userIds: string[], title: string, body: string, metadata: Record<string, unknown>) => {
  if (!userIds.length) return;
  const { error } = await db.from("notifications").insert(userIds.map((userId) => ({ user_id: userId, kind: "clan", title: title.slice(0, 120), body: body.slice(0, 500), metadata })));
  if (error) console.warn("[legacy-x-api] clan war notification not saved", error.message);
};

/** Extra member slots for every level the clan has reached since the last time this ran (each level pays once). */
export async function applyLevelPerks(db: Db, clanId: string) {
  const { data: progress } = await db.from("clan_progress").select("xp,perk_level").eq("clan_id", clanId).maybeSingle();
  if (!progress) return;
  const { level } = levelFor(Number(progress.xp));
  const done = Number(progress.perk_level) || 1;
  if (level <= done) return;
  // Claimed first, so two matches finishing together cannot both hand out the same slots.
  const claimed = await db.from("clan_progress").update({ perk_level: level, updated_at: new Date().toISOString() }).eq("clan_id", clanId).eq("perk_level", done).select("clan_id");
  if (claimed.error || !(claimed.data ?? []).length) return;
  const slots = LEVEL_PERKS.filter((perk) => perk.level > done && perk.level <= level).reduce((sum, perk) => sum + perk.slots, 0);
  if (slots > 0) {
    const { data: clan } = await db.from("clans").select("max_players").eq("id", clanId).maybeSingle();
    if (clan) await db.from("clans").update({ max_players: Number(clan.max_players) + slots }).eq("id", clanId).eq("max_players", clan.max_players);
  }
  const { data: managers } = await db.from("clan_members").select("user_id").eq("clan_id", clanId).in("role", ["leader", "co-leader"]);
  await tell(db, ((managers ?? []) as Row[]).map((row) => String(row.user_id)), `Clan level ${level}`, slots > 0 ? `Your clan reached level ${level} and got ${slots} more member slot${slots === 1 ? "" : "s"}.` : `Your clan reached level ${level}.`, { kind: "clan_level", level });
}

const addXp = async (db: Db, clanId: string, ref: string, xp: number, reason: string) => {
  if (xp <= 0) return;
  const { error } = await db.rpc("add_clan_xp", { p_clan_id: clanId, p_ref: ref, p_xp: xp, p_reason: reason });
  if (error) throw error;
};

/**
 * After a ranked match: clan XP for every member who played it (in the clan before the match ended), and, when the two teams are
 * two clans with an accepted war at about this time, the war's result, rating and XP. A replayed match changes nothing (refs).
 */
export async function recordClanMatch(db: Db, matchId: string, players: FinishedPlayer[], finishedAt: Date, score: Record<string, number> | null) {
  if (!players.length) return;
  const { data, error } = await db.from("clan_members").select("user_id,clan_id,created_at").in("user_id", players.map((player) => player.userId));
  if (error) throw error;
  const clanOf = new Map<string, string>();
  for (const row of (data ?? []) as Row[]) if (Date.parse(String(row.created_at)) <= finishedAt.getTime()) clanOf.set(String(row.user_id), String(row.clan_id));
  const touched = new Set<string>();
  for (const player of players) {
    const clanId = clanOf.get(player.userId);
    if (!clanId) continue;
    await addXp(db, clanId, `match:${matchId}:${player.userId}`, matchXp(player.outcome, player.breakdown?.rule === "leaver"), "match");
    touched.add(clanId);
  }

  const sides = warSides(players.map((player) => ({ userId: player.userId, team: player.team })), clanOf);
  if (sides) {
    const [a, b] = sides;
    const from = new Date(finishedAt.getTime() - WAR_WINDOW_AFTER_MS).toISOString();
    const to = new Date(finishedAt.getTime() + WAR_WINDOW_BEFORE_MS).toISOString();
    const { data: wars } = await db.from("clan_wars").select("id,challenger_id,opponent_id").eq("status", "accepted").is("match_id", null)
      .or(`and(challenger_id.eq.${a.clanId},opponent_id.eq.${b.clanId}),and(challenger_id.eq.${b.clanId},opponent_id.eq.${a.clanId})`)
      .gte("scheduled_at", from).lte("scheduled_at", to).order("scheduled_at").limit(1);
    const war = ((wars ?? []) as Row[])[0];
    if (war) {
      const teamOf = new Map(sides.map((side) => [side.clanId, side.team]));
      const challengerTeam = teamOf.get(String(war.challenger_id))!;
      const opponentTeam = teamOf.get(String(war.opponent_id))!;
      const challengerOutcome = players.find((player) => player.team === challengerTeam)?.outcome ?? "draw";
      const scoreA: 0 | 0.5 | 1 = challengerOutcome === "win" ? 1 : challengerOutcome === "draw" ? 0.5 : 0;
      const { data: ratings } = await db.from("clan_progress").select("clan_id,war_rating,war_wins,war_losses,war_draws").in("clan_id", [war.challenger_id, war.opponent_id]);
      const ratingOf = (clanId: string) => ((ratings ?? []) as Row[]).find((row) => String(row.clan_id) === clanId);
      const challengerRow = ratingOf(String(war.challenger_id));
      const opponentRow = ratingOf(String(war.opponent_id));
      const change = warRatingChange(Number(challengerRow?.war_rating ?? 1000), Number(opponentRow?.war_rating ?? 1000), scoreA);
      const winnerId = scoreA === 1 ? war.challenger_id : scoreA === 0 ? war.opponent_id : null;
      // Settled once: only the update that still finds the war open goes on.
      const settled = await db.from("clan_wars").update({
        status: "finished", match_id: matchId, winner_id: winnerId, rating_change: change,
        score_challenger: score ? score[challengerTeam] ?? null : null, score_opponent: score ? score[opponentTeam] ?? null : null,
        updated_at: new Date().toISOString(),
      }).eq("id", war.id).eq("status", "accepted").is("match_id", null).select("id");
      if (!settled.error && (settled.data ?? []).length) {
        const record = async (clanId: string, row: Row | undefined, delta: number, result: "win" | "loss" | "draw") => {
          const next = {
            clan_id: clanId,
            war_rating: Number(row?.war_rating ?? 1000) + delta,
            war_wins: Number(row?.war_wins ?? 0) + (result === "win" ? 1 : 0),
            war_losses: Number(row?.war_losses ?? 0) + (result === "loss" ? 1 : 0),
            war_draws: Number(row?.war_draws ?? 0) + (result === "draw" ? 1 : 0),
            updated_at: new Date().toISOString(),
          };
          const saved = await db.from("clan_progress").upsert(next, { onConflict: "clan_id" });
          if (saved.error) throw saved.error;
          await addXp(db, clanId, `war:${war.id}:${clanId}`, result === "win" ? WAR_XP.win : WAR_XP.played, "war");
          touched.add(clanId);
        };
        const challengerResult = scoreA === 1 ? "win" : scoreA === 0 ? "loss" : "draw";
        const opponentResult = scoreA === 1 ? "loss" : scoreA === 0 ? "win" : "draw";
        await record(String(war.challenger_id), challengerRow, change, challengerResult);
        await record(String(war.opponent_id), opponentRow, -change, opponentResult);
        const { data: managers } = await db.from("clan_members").select("user_id,clan_id").in("clan_id", [war.challenger_id, war.opponent_id]).in("role", ["leader", "co-leader"]);
        for (const [clanId, result] of [[String(war.challenger_id), challengerResult], [String(war.opponent_id), opponentResult]] as const) {
          const ids = ((managers ?? []) as Row[]).filter((row) => String(row.clan_id) === clanId).map((row) => String(row.user_id));
          await tell(db, ids, result === "win" ? "Clan War won" : result === "loss" ? "Clan War lost" : "Clan War drawn", "The result of your Clan War is in. Open the clan's Wars tab for the rating change.", { kind: "clan_war", warId: war.id, result });
        }
      }
    }
  }
  for (const clanId of Array.from(touched)) await applyLevelPerks(db, clanId);
}
