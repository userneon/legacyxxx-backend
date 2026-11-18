import sharp from "sharp";
import { z } from "zod";

/**
 * Creator ads on Home (owner request 2026-11-18): a content creator pays FOL$ to show one of their TikTok videos as a banner in the Home slider.
 * Only a TikTok video link is sent; the title and the banner picture come from TikTok itself (its public oEmbed answer), never from the creator.
 * supabase/legacy_x_creator_ads.sql keeps them; staff approve each one and the price is taken at approval.
 */
export const AD_PRICES: Record<24 | 48, number> = { 24: 5000, 48: 8000 };
export const AD_HOURS = [24, 48] as const;
/** The most ads shown in the slider at once (the rest wait their turn by showing as soon as one ends). */
export const AD_SLOTS = 5;

export const creatorAdSchema = z.object({ url: z.string().trim().min(20).max(300), hours: z.union([z.literal(24), z.literal(48)]) }).strict();
export const creatorAdDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(300).default("") }).strict();

export type TikTokVideo = { url: string; handle: string; videoId: string };

/** The canonical link only: https://www.tiktok.com/@name/video/1234567890123456789 (short links and other hosts are refused; they cannot be checked). */
export function parseTikTokVideoUrl(raw: string): TikTokVideo | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || !/^(www\.)?tiktok\.com$/i.test(url.hostname)) return null;
    const match = /^\/(@[A-Za-z0-9._]{2,24})\/video\/(\d{8,25})\/?$/.exec(url.pathname);
    if (!match) return null;
    return { url: `https://www.tiktok.com/${match[1]}/video/${match[2]}`, handle: match[1].toLowerCase(), videoId: match[2] };
  } catch {
    return null;
  }
}

/** Where TikTok keeps its thumbnails: the picture is only fetched from these hosts (nothing else a creator or an answer names is ever requested). */
const IMAGE_HOSTS = [/\.tiktokcdn\.com$/i, /\.tiktokcdn-us\.com$/i, /\.tiktok\.com$/i, /\.ibyteimg\.com$/i, /\.byteimg\.com$/i, /\.muscdn\.com$/i, /\.ttwstatic\.com$/i];
export const trustedImageHost = (host: string) => IMAGE_HOSTS.some((pattern) => pattern.test(host));

/** Control characters and invisible marks, built from escapes so the source stays plain ASCII. */
const CONTROL_MARKS = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202f\\ufeff]", "g");

export type OEmbed = { title: string; authorUrl: string; thumbnailUrl: string };

export async function fetchOEmbed(videoUrl: string, fetcher: typeof fetch = fetch): Promise<OEmbed> {
  const response = await fetcher(`https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("TikTok does not know this video");
  const body = (await response.json()) as Record<string, unknown>;
  const thumbnailUrl = typeof body.thumbnail_url === "string" ? body.thumbnail_url : "";
  const authorUrl = typeof body.author_url === "string" ? body.author_url : "";
  const title = typeof body.title === "string" ? body.title.replace(CONTROL_MARKS, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!thumbnailUrl) throw new Error("TikTok gave no picture for this video");
  return { title, authorUrl, thumbnailUrl };
}

/** The handle named by the oEmbed answer's author link (https://www.tiktok.com/@name), lower case. */
export function oembedHandle(authorUrl: string): string | null {
  try {
    const url = new URL(authorUrl);
    const handle = url.pathname.split("/").find((part) => /^@[A-Za-z0-9._]{2,24}$/.test(part));
    return handle ? handle.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Downloads the thumbnail from a TikTok host and makes it a 1280x720 WebP banner (a picture of any shape is cropped to the middle). */
export async function bannerFromThumbnail(thumbnailUrl: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
  let url: URL;
  try { url = new URL(thumbnailUrl); } catch { throw new Error("TikTok gave a bad picture link"); }
  if (url.protocol !== "https:" || !trustedImageHost(url.hostname)) throw new Error("The picture is not from TikTok");
  const response = await fetcher(url, { signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!response.ok) throw new Error("The picture could not be downloaded");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 6 * 1024 * 1024) throw new Error("The picture is empty or too large");
  let quality = 82;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const data = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).rotate().resize({ width: 1280, height: 720, fit: "cover", position: "centre" }).webp({ quality }).toBuffer();
    if (data.length <= 450_000) return data;
    quality -= 14;
  }
  throw new Error("The picture is too detailed to keep");
}

/** What a creator's saved TikTok link names (their profile), for the check that the video is theirs. */
export function creatorTikTokHandle(link: unknown): string | null {
  if (typeof link !== "string") return null;
  try {
    const url = new URL(link.startsWith("http") ? link : `https://${link}`);
    if (!/^(www\.)?tiktok\.com$/i.test(url.hostname)) return null;
    const handle = url.pathname.split("/").find((part) => /^@[A-Za-z0-9._]{2,24}$/.test(part));
    return handle ? handle.toLowerCase() : null;
  } catch {
    return null;
  }
}
