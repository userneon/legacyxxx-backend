import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { discordIdSchema } from "./discordLinks";
import { legacyXError } from "./supabase";

/**
 * Discord boosts and invites for the Leaders → Boosters page. The bot sends what it sees: who boosts right now (Discord does not
 * say how many boosts a member applied, so the bot also counts boost messages it witnesses), and how many members joined through
 * each member's invites. Counts only ever go up here: a deleted invite or a stopped boost does not take credit away.
 */
type Db = SupabaseClient<any, any, any, any, any>;
type Row = Record<string, unknown>;

export const communityInputSchema = z.object({
  /** Members who boost the server right now, with the date Discord says they started. */
  boosters: z.array(z.object({ discordId: discordIdSchema, since: z.string().datetime().nullable().optional() })).max(2000).default([]),
  /** Boost messages the bot saw since the last report: one entry per message, `count` boosts each. */
  boostEvents: z.array(z.object({ discordId: discordIdSchema, count: z.number().int().min(1).max(14).default(1) })).max(2000).default([]),
  /** Total uses of every invite each member made, as Discord shows them now. */
  inviters: z.array(z.object({ discordId: discordIdSchema, uses: z.number().int().min(0).max(1_000_000) })).max(5000).default([]),
});
export type CommunityInput = z.infer<typeof communityInputSchema>;

export interface CommunityStat { discordId: string; boosts: number; boostingSince: string | null; invites: number }

/** The new rows for the members the report mentions, given what is stored. A booster has at least one boost; counts never go down. */
export function mergeCommunity(existing: CommunityStat[], input: CommunityInput): CommunityStat[] {
  const rows = new Map(existing.map((row) => [row.discordId, { ...row }]));
  const touched = new Set<string>();
  const row = (discordId: string) => {
    touched.add(discordId);
    let current = rows.get(discordId);
    if (!current) { current = { discordId, boosts: 0, boostingSince: null, invites: 0 }; rows.set(discordId, current); }
    return current;
  };
  for (const event of input.boostEvents) { const current = row(event.discordId); current.boosts += event.count; }
  for (const booster of input.boosters) {
    const current = row(booster.discordId);
    current.boosts = Math.max(current.boosts, 1);
    if (booster.since && (!current.boostingSince || booster.since < current.boostingSince)) current.boostingSince = booster.since;
  }
  for (const inviter of input.inviters) { const current = row(inviter.discordId); current.invites = Math.max(current.invites, inviter.uses); }
  return Array.from(touched).map((id) => rows.get(id)!);
}

const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

export async function recordCommunity(db: Db, input: CommunityInput) {
  const ids = Array.from(new Set([...input.boosters, ...input.boostEvents, ...input.inviters].map((entry) => entry.discordId)));
  const existing: CommunityStat[] = [];
  for (let index = 0; index < ids.length; index += 200) {
    const { data, error } = await db.from("discord_community_stats").select("discord_id,boosts,boosting_since,invites").in("discord_id", ids.slice(index, index + 200));
    legacyXError(error, "Unable to read Discord community stats");
    for (const row of (data ?? []) as Row[]) existing.push({ discordId: text(row.discord_id), boosts: num(row.boosts), boostingSince: row.boosting_since ? text(row.boosting_since) : null, invites: num(row.invites) });
  }
  const merged = mergeCommunity(existing, input);
  if (merged.length === 0) return 0;
  const now = new Date().toISOString();
  const { error } = await db.from("discord_community_stats").upsert(merged.map((row) => ({ discord_id: row.discordId, boosts: row.boosts, boosting_since: row.boostingSince, invites: row.invites, updated_at: now })), { onConflict: "discord_id" });
  legacyXError(error, "Unable to save Discord community stats");
  return merged.length;
}

export interface CommunityEntry { position: number; steamId: string; username: string; avatar: string; boosts: number; boostingSince: string | null; invites: number }

/** Linked members ranked by boosts or by invites (ties: the earlier booster, then the name). Members who did neither are left out. */
export async function loadCommunity(db: Db, sort: "boosts" | "invites", limit = 100): Promise<CommunityEntry[]> {
  const column = sort === "boosts" ? "boosts" : "invites";
  const { data, error } = await db.from("discord_community_stats").select("discord_id,boosts,boosting_since,invites").gt(column, 0).order(column, { ascending: false }).limit(1000);
  legacyXError(error, "Unable to load Discord community stats");
  const stats = (data ?? []) as Row[];
  if (stats.length === 0) return [];
  const links: Row[] = [];
  const discordIds = stats.map((row) => text(row.discord_id));
  for (let index = 0; index < discordIds.length; index += 200) {
    const { data: rows, error: linkError } = await db.from("discord_links").select("discord_id,users(steam_id,username,avatar)").in("discord_id", discordIds.slice(index, index + 200));
    legacyXError(linkError, "Unable to load Discord links");
    links.push(...((rows ?? []) as Row[]));
  }
  const user = (link: Row) => (Array.isArray(link.users) ? (link.users[0] as Row) : (link.users as Row)) ?? {};
  const byDiscord = new Map(links.map((link) => [text(link.discord_id), user(link)]));
  const entries = stats.flatMap((row) => {
    const profile = byDiscord.get(text(row.discord_id));
    if (!profile || !text(profile.steam_id)) return [];
    return [{ steamId: text(profile.steam_id), username: text(profile.username), avatar: text(profile.avatar), boosts: num(row.boosts), boostingSince: row.boosting_since ? text(row.boosting_since) : null, invites: num(row.invites) }];
  });
  entries.sort((a, b) => b[column] - a[column] || (a.boostingSince ?? "9").localeCompare(b.boostingSince ?? "9") || a.username.localeCompare(b.username));
  return entries.slice(0, limit).map((entry, index) => ({ position: index + 1, ...entry }));
}
