/**
 * LEGACY-X's TikTok numbers for Home (owner request 2026-11-13: "followers, posts").
 * TikTok has no open API, so the server reads the public profile page once an hour (a plain GET, like a browser) and keeps the answer;
 * the browser never calls TikTok. The page is not a contract: when TikTok changes it, or blocks the request, the numbers are simply
 * left out (null) and Home shows the card without them. Nothing is estimated or made up. Set TIKTOK_URL (https://www.tiktok.com/@name).
 */

export type TikTokStats = { url: string; handle: string; followers: number | null; videos: number | null; updatedAt: string | null };

const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

/** The https tiktok.com/@name link from the setting, or null when it is missing or not a TikTok profile. */
export function tiktokProfile(raw: string | undefined | null): { url: string; handle: string } | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || !/^(www\.)?tiktok\.com$/i.test(url.hostname)) return null;
    const handle = url.pathname.split("/").find((part) => /^@[A-Za-z0-9._]{2,24}$/.test(part));
    if (!handle) return null;
    return { url: `https://www.tiktok.com/${handle}`, handle };
  } catch {
    return null;
  }
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

/** Followers and video count from the profile page's embedded JSON. Null parts when the page does not carry them. */
export function parseTikTokPage(html: string): { followers: number | null; videos: number | null } {
  const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return { followers: null, videos: null };
  try {
    const data = JSON.parse(match[1]) as Record<string, any>;
    const stats = data?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.stats;
    return { followers: count(stats?.followerCount), videos: count(stats?.videoCount) };
  } catch {
    return { followers: null, videos: null };
  }
}

let cached: { key: string; value: TikTokStats; until: number } | null = null;

export async function getTikTokStats(raw = process.env.TIKTOK_URL): Promise<TikTokStats | null> {
  const profile = tiktokProfile(raw);
  if (!profile) return null;
  if (cached && cached.key === profile.url && cached.until > Date.now()) return cached.value;
  const keep = cached && cached.key === profile.url ? cached.value : null;
  try {
    const response = await fetch(profile.url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const parsed = response.ok ? parseTikTokPage(await response.text()) : { followers: null, videos: null };
    const fresh = parsed.followers != null || parsed.videos != null;
    // A failed read keeps the last good numbers (and tries again in ten minutes) instead of dropping them.
    const value: TikTokStats = fresh
      ? { ...profile, ...parsed, updatedAt: new Date().toISOString() }
      : keep ?? { ...profile, followers: null, videos: null, updatedAt: null };
    cached = { key: profile.url, value, until: Date.now() + (fresh ? TTL_MS : RETRY_MS) };
    return value;
  } catch {
    const value = keep ?? { ...profile, followers: null, videos: null, updatedAt: null };
    cached = { key: profile.url, value, until: Date.now() + RETRY_MS };
    return value;
  }
}
