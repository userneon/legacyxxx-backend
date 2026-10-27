import { z } from "zod";
import { withHttps } from "./creators";

/**
 * Links on a clan's page (owner request 2026-10-26): where the clan is found outside the site. https only, each on the platform's own
 * host, so a link can never point somewhere unexpected. The leader sets them with the other clan settings.
 */
export const CLAN_LINK_PLATFORMS = {
  discord: ["discord.gg", "discord.com", "discordapp.com"],
  facebook: ["facebook.com", "fb.com", "fb.gg"],
  youtube: ["youtube.com", "youtu.be"],
  twitch: ["twitch.tv"],
  kick: ["kick.com"],
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
  steam: ["steamcommunity.com"],
} as const;
export type ClanLinkPlatform = keyof typeof CLAN_LINK_PLATFORMS;

/** https, on that platform's own host (or a subdomain of it), no login in the address, at most 200 characters. */
export function validClanLink(platform: ClanLinkPlatform, value: string): boolean {
  if (value.length > 200) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return CLAN_LINK_PLATFORMS[platform].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

const link = (platform: ClanLinkPlatform) => z.string().trim().max(200).optional()
  .transform((value) => (value ? withHttps(value) : undefined))
  .refine((value) => value === undefined || validClanLink(platform, value), { message: `Not a ${platform} link` });

/** What the leader sends: any of the platforms, an empty one is left out. Sending `{}` clears every link. */
export const clanLinksSchema = z.object({
  discord: link("discord"),
  facebook: link("facebook"),
  youtube: link("youtube"),
  twitch: link("twitch"),
  kick: link("kick"),
  instagram: link("instagram"),
  tiktok: link("tiktok"),
  steam: link("steam"),
}).strict().transform((value) => Object.fromEntries(Object.entries(value).filter(([, url]) => url)) as Partial<Record<ClanLinkPlatform, string>>);

/** What is stored, read back safely: only known platforms with a link that still passes the check. */
export function cleanClanLinks(value: unknown): Partial<Record<ClanLinkPlatform, string>> {
  if (!value || typeof value !== "object") return {};
  const out: Partial<Record<ClanLinkPlatform, string>> = {};
  for (const platform of Object.keys(CLAN_LINK_PLATFORMS) as ClanLinkPlatform[]) {
    const url = (value as Record<string, unknown>)[platform];
    if (typeof url === "string" && validClanLink(platform, url)) out[platform] = url;
  }
  return out;
}
