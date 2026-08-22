const steamId64Pattern = /^\d{17}$/;
const cache = new Map<string, { expiresAt: number; value: string | null }>();
const positiveCacheMs = 60 * 60 * 1000;
const negativeCacheMs = 10 * 60 * 1000;
const maxCacheEntries = 500;

function cacheResult(steamId: string, value: string | null) {
  if (cache.size >= maxCacheEntries && !cache.has(steamId)) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(steamId, { value, expiresAt: Date.now() + (value ? positiveCacheMs : negativeCacheMs) });
  return value;
}

function safeSteamBackgroundUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const allowedHost = hostname.endsWith("steamstatic.com") || hostname === "steamcommunity-a.akamaihd.net";
    return url.protocol === "https:" && allowedHost ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function resolvePublicSteamBackground(steamId: string): Promise<string | null> {
  if (!steamId64Pattern.test(steamId)) return null;
  const existing = cache.get(steamId);
  if (existing && existing.expiresAt > Date.now()) return existing.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`https://steamcommunity.com/profiles/${steamId}`, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "LEGACY-X Profile Background Resolver/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) return cacheResult(steamId, null);

    const html = await response.text();
    const profileBackgroundTag = html.match(/<div[^>]*class="[^"]*\bprofile_background\b[^"]*"[^>]*>/i)?.[0] ?? "";
    const rawUrl = profileBackgroundTag.match(/background-image\s*:\s*url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/i)?.[1];
    return cacheResult(steamId, rawUrl ? safeSteamBackgroundUrl(rawUrl) : null);
  } catch {
    return cacheResult(steamId, null);
  } finally {
    clearTimeout(timer);
  }
}
