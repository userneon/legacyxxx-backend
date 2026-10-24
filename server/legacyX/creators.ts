import { z } from "zod";

/**
 * Content creators (owner request 2026-10-12): Main Content Creator and Content Creator. A creator is a player account with a tier, a
 * short line about them and links to their channels. It is shown as a badge on the profile and on the Creators page, and gives no
 * staff permission. Owners and Managers manage the list from the Staff page.
 */

export const CREATOR_TIERS = ["main", "creator"] as const;
export type CreatorTier = (typeof CREATOR_TIERS)[number];
export const CREATOR_TIER_LABEL: Record<CreatorTier, string> = { main: "Main Content Creator", creator: "Content Creator" };

/** The platforms a creator can link, each with the hosts its links may point to (https only). */
export const CREATOR_PLATFORMS = {
  twitch: ["twitch.tv"],
  youtube: ["youtube.com", "youtu.be"],
  tiktok: ["tiktok.com"],
  kick: ["kick.com"],
  facebook: ["facebook.com", "fb.com", "fb.gg"],
  instagram: ["instagram.com"],
} as const;
export type CreatorPlatform = keyof typeof CREATOR_PLATFORMS;

/** A channel link for one platform: https, on that platform's own host (or a subdomain of it), at most 200 characters. */
export function validCreatorLink(platform: CreatorPlatform, value: string): boolean {
  if (value.length > 200) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return CREATOR_PLATFORMS[platform].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** What players paste: "www.tiktok.com/@name" or "http://…" is taken as the https link it means. */
export function withHttps(value: string): string {
  const text = value.trim();
  if (!text) return text;
  if (/^http:\/\//i.test(text)) return `https://${text.slice(7)}`;
  if (text.includes("://")) return text;
  return `https://${text.replace(/^\/+/, "")}`;
}

const link = (platform: CreatorPlatform) => z.string().trim().max(200).optional()
  .transform((value) => (value ? withHttps(value) : undefined))
  .refine((value) => value === undefined || validCreatorLink(platform, value), { message: `Not a ${platform} link` });

const linksSchema = z.object({
  twitch: link("twitch"),
  youtube: link("youtube"),
  tiktok: link("tiktok"),
  kick: link("kick"),
  facebook: link("facebook"),
  instagram: link("instagram"),
}).strict();

export const upsertCreatorSchema = z.object({
  tier: z.enum(CREATOR_TIERS),
  bio: z.string().trim().max(200).default(""),
  links: linksSchema.optional().transform((value) => Object.fromEntries(Object.entries(value ?? {}).filter(([, url]) => url)) as Partial<Record<CreatorPlatform, string>>),
  sort: z.number().int().min(-100).max(100).default(0),
});

const trimmedLinks = (value: z.infer<typeof linksSchema>) => Object.fromEntries(Object.entries(value).filter(([, url]) => url)) as Partial<Record<CreatorPlatform, string>>;

/** A player's application to become a creator: a short line about their content and at least one valid channel link. */
export const creatorApplicationSchema = z.object({
  bio: z.string().trim().min(10, "Tell us a little about your content (10 characters or more)").max(200),
  links: linksSchema.transform(trimmedLinks),
}).strict().refine((value) => Object.keys(value.links).length > 0, { message: "Add at least one channel link", path: ["links"] });

/** An Owner's or Manager's answer. `tier` is only used when approving. */
export const creatorDecisionSchema = z.object({
  decision: z.enum(["approve", "decline"]),
  tier: z.enum(CREATOR_TIERS).default("creator"),
  note: z.string().trim().max(200).default(""),
}).strict();

/** A player who was turned down may ask again after this long; one who is waiting cannot ask twice. */
export const CREATOR_REAPPLY_DAYS = 7;

/** Stored links, cleaned again on the way out: only known platforms with a valid link survive. */
export function cleanCreatorLinks(raw: unknown): Partial<Record<CreatorPlatform, string>> {
  const out: Partial<Record<CreatorPlatform, string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const platform of Object.keys(CREATOR_PLATFORMS) as CreatorPlatform[]) {
    const value = (raw as Record<string, unknown>)[platform];
    if (typeof value === "string" && validCreatorLink(platform, value)) out[platform] = value;
  }
  return out;
}

export function creatorTier(value: unknown): CreatorTier | null {
  return value === "main" || value === "creator" ? value : null;
}

/** Main creators first, then by the staff-set order, then the earliest added. */
export function sortCreators<T extends { tier: CreatorTier; sort: number; createdAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "main" ? -1 : 1) || a.sort - b.sort || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
