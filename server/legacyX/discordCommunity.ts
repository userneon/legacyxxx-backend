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

const profileFields = {
  name: z.string().trim().max(64).optional(),
  username: z.string().trim().max(64).optional(),
  avatar: z.string().max(300).regex(/^https:\/\/cdn\.discordapp\.com\//).optional(),
};

export const communityInputSchema = z.object({
  /** Members who boost the server right now, with the date Discord says they started. */
  boosters: z.array(z.object({ discordId: discordIdSchema, since: z.string().datetime().nullable().optional(), ...profileFields })).max(2000).default([]),
  /** Boost messages the bot saw since the last report: one entry per message, `count` boosts each. */
  boostEvents: z.array(z.object({ discordId: discordIdSchema, count: z.number().int().min(1).max(14).default(1), ...profileFields })).max(2000).default([]),
  /** Total uses of every invite each member made, as Discord shows them now. */
  /** True when `boosters` is every current booster, so anyone else has stopped boosting. */
  boostersComplete: z.boolean().default(false),
  inviters: z.array(z.object({ discordId: discordIdSchema, uses: z.number().int().min(0).max(1_000_000), ...profileFields })).max(5000).default([]),
});
export type CommunityInput = z.infer<typeof communityInputSchema>;

export interface CommunityStat { discordId: string; boosts: number; boostingSince: string | null; invites: number; boosting?: boolean; name?: string; username?: string; avatar?: string }

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
  // The newest profile the bot sent wins (names and avatars change).
  const profile = (discordId: string, entry: { name?: string; username?: string; avatar?: string }) => {
    const current = row(discordId);
    if (entry.name) current.name = entry.name;
    if (entry.username) current.username = entry.username;
    if (entry.avatar) current.avatar = entry.avatar;
  };
  for (const event of input.boostEvents) { const current = row(event.discordId); current.boosts += event.count; profile(event.discordId, event); }
  for (const booster of input.boosters) {
    const current = row(booster.discordId);
    profile(booster.discordId, booster);
    current.boosting = true;
    current.boosts = Math.max(current.boosts, 1);
    if (booster.since && (!current.boostingSince || booster.since < current.boostingSince)) current.boostingSince = booster.since;
  }
  for (const inviter of input.inviters) { const current = row(inviter.discordId); current.invites = Math.max(current.invites, inviter.uses); profile(inviter.discordId, inviter); }
  return Array.from(touched).map((id) => rows.get(id)!);
}

const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

export async function recordCommunity(db: Db, input: CommunityInput) {
  const ids = Array.from(new Set([...input.boosters, ...input.boostEvents, ...input.inviters].map((entry) => entry.discordId)));
  const existing: CommunityStat[] = [];
  for (let index = 0; index < ids.length; index += 200) {
    const { data, error } = await db.from("discord_community_stats").select("discord_id,boosts,boosting_since,invites,boosting,display_name,username,avatar").in("discord_id", ids.slice(index, index + 200));
    legacyXError(error, "Unable to read Discord community stats");
    for (const row of (data ?? []) as Row[]) existing.push({ discordId: text(row.discord_id), boosts: num(row.boosts), boostingSince: row.boosting_since ? text(row.boosting_since) : null, invites: num(row.invites), boosting: row.boosting === true, name: text(row.display_name), username: text(row.username), avatar: text(row.avatar) });
  }
  const merged = mergeCommunity(existing, input);
  if (merged.length === 0 && !input.boostersComplete) return 0;
  if (merged.length > 0) {
    const now = new Date().toISOString();
    const { error } = await db.from("discord_community_stats").upsert(merged.map((row) => ({ discord_id: row.discordId, boosts: row.boosts, boosting_since: row.boostingSince, invites: row.invites, boosting: row.boosting ?? false, display_name: row.name ?? "", username: row.username ?? "", avatar: row.avatar ?? "", updated_at: now })), { onConflict: "discord_id" });
    legacyXError(error, "Unable to save Discord community stats");
  }
  if (input.boostersComplete) await endStoppedBoosts(db, new Set(input.boosters.map((booster) => booster.discordId)));
  return merged.length;
}

/** Everyone marked as boosting who is not in the report's list has stopped. */
async function endStoppedBoosts(db: Db, current: Set<string>) {
  const { data, error } = await db.from("discord_community_stats").select("discord_id").eq("boosting", true).limit(5000);
  legacyXError(error, "Unable to read Discord boosters");
  const stopped = ((data ?? []) as Row[]).map((row) => text(row.discord_id)).filter((id) => !current.has(id));
  for (let index = 0; index < stopped.length; index += 200) {
    const { error: updateError } = await db.from("discord_community_stats").update({ boosting: false }).in("discord_id", stopped.slice(index, index + 200));
    legacyXError(updateError, "Unable to save Discord boosters");
  }
}

export interface CommunityEntry { position: number; discordId: string; name: string; username: string; avatar: string; steamId: string | null; boosting: boolean; boosts: number; boostingSince: string | null; invites: number }

/** Discord members ranked by boosts or by invites (ties: the earlier booster, then the name). Members who did neither are left out.
 *  A member who linked Discord to a LEGACY-X profile carries its Steam ID, so the page can open the profile. */
export async function loadCommunity(db: Db, sort: "boosts" | "invites", limit = 100): Promise<CommunityEntry[]> {
  const column = sort === "boosts" ? "boosts" : "invites";
  const { data, error } = await db.from("discord_community_stats").select("discord_id,boosts,boosting_since,invites,boosting,display_name,username,avatar").gt(column, 0).order(column, { ascending: false }).limit(1000);
  legacyXError(error, "Unable to load Discord community stats");
  const stats = (data ?? []) as Row[];
  if (stats.length === 0) return [];
  const links: Row[] = [];
  const discordIds = stats.map((row) => text(row.discord_id));
  for (let index = 0; index < discordIds.length; index += 200) {
    const { data: rows, error: linkError } = await db.from("discord_links").select("discord_id,discord_name,users(steam_id,username,avatar)").in("discord_id", discordIds.slice(index, index + 200));
    legacyXError(linkError, "Unable to load Discord links");
    links.push(...((rows ?? []) as Row[]));
  }
  const user = (link: Row) => (Array.isArray(link.users) ? (link.users[0] as Row) : (link.users as Row)) ?? {};
  const byDiscord = new Map(links.map((link) => [text(link.discord_id), link]));
  const entries = stats.flatMap((row) => {
    const link = byDiscord.get(text(row.discord_id));
    const profile = link ? user(link) : {};
    const username = text(row.username) || text(link?.discord_name);
    const name = text(row.display_name) || username;
    if (!name) return [];
    return [{ discordId: text(row.discord_id), name, username, avatar: text(row.avatar), steamId: text(profile.steam_id) || null, boosting: row.boosting === true, boosts: num(row.boosts), boostingSince: row.boosting_since ? text(row.boosting_since) : null, invites: num(row.invites) }];
  });
  entries.sort((a, b) => b[column] - a[column] || (a.boostingSince ?? "9").localeCompare(b.boostingSince ?? "9") || a.name.localeCompare(b.name));
  return entries.slice(0, limit).map((entry, index) => ({ position: index + 1, ...entry }));
}
