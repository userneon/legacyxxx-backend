const steamId64Pattern = /^\d{17}$/;
const positiveCacheMs = 60 * 60 * 1000;
const negativeCacheMs = 10 * 60 * 1000;
const maxCacheEntries = 500;
/** Relative item paths from IPlayerService are served from Steam's community image CDN. */
const steamItemImageBase = "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/";

export type SteamProfileMedia = {
  /** Still background image; also the poster for an animated background. */
  background: string | null;
  backgroundVideo: { webm: string | null; mp4: string | null } | null;
  animatedAvatar: string | null;
  avatarFrame: string | null;
};

const emptyMedia: SteamProfileMedia = { background: null, backgroundVideo: null, animatedAvatar: null, avatarFrame: null };
const cache = new Map<string, { expiresAt: number; value: SteamProfileMedia }>();

function cacheResult(steamId: string, value: SteamProfileMedia) {
  if (cache.size >= maxCacheEntries && !cache.has(steamId)) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  const found = Boolean(value.background || value.animatedAvatar || value.avatarFrame);
  cache.set(steamId, { value, expiresAt: Date.now() + (found ? positiveCacheMs : negativeCacheMs) });
  return value;
}

function safeSteamMediaUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, steamItemImageBase);
    const hostname = url.hostname.toLowerCase();
    const allowedHost = hostname.endsWith("steamstatic.com") || hostname === "steamcommunity-a.akamaihd.net";
    return url.protocol === "https:" && allowedHost ? url.toString() : null;
  } catch {
    return null;
  }
}

function item(response: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = response[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Reads the player's equipped Steam Points Shop items (background, animated avatar, avatar frame) from the public
 * IPlayerService API. This replaces scraping the profile HTML, whose markup (`has_profile_background`) never matched.
 */
export async function resolveSteamProfileMedia(steamId: string): Promise<SteamProfileMedia> {
  if (!steamId64Pattern.test(steamId)) return emptyMedia;
  const existing = cache.get(steamId);
  if (existing && existing.expiresAt > Date.now()) return existing.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`https://api.steampowered.com/IPlayerService/GetProfileItemsEquipped/v1/?steamid=${steamId}`, {
      headers: { Accept: "application/json", "User-Agent": "LEGACY-X Profile Media Resolver/2.0" },
      signal: controller.signal,
    });
    if (!response.ok) return cacheResult(steamId, emptyMedia);

    const body = (await response.json()) as { response?: Record<string, unknown> };
    const equipped = body.response ?? {};
    const background = item(equipped, "profile_background");
    const avatar = item(equipped, "animated_avatar");
    const frame = item(equipped, "avatar_frame");
    const webm = safeSteamMediaUrl(background.movie_webm);
    const mp4 = safeSteamMediaUrl(background.movie_mp4);

    return cacheResult(steamId, {
      background: safeSteamMediaUrl(background.image_large),
      backgroundVideo: webm || mp4 ? { webm, mp4 } : null,
      // image_small is the animated GIF; image_large is a still frame.
      animatedAvatar: safeSteamMediaUrl(avatar.image_small) ?? safeSteamMediaUrl(avatar.image_large),
      // Frames must be the transparent (A)PNG in image_large; image_small can be an opaque JPG store thumbnail.
      avatarFrame: [frame.image_large, frame.image_small].map(safeSteamMediaUrl).find((url) => url && /\.png$/i.test(new URL(url).pathname)) ?? null,
    });
  } catch {
    return cacheResult(steamId, emptyMedia);
  } finally {
    clearTimeout(timer);
  }
}
