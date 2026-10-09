import { legacyXDb, legacyXError } from "./supabase";

export type SteamProfile = {
  username: string;
  avatar: string;
};

function steamWebApiKey() {
  const value = process.env.STEAM_WEB_API_KEY?.trim();
  if (!value) throw Object.assign(new Error("Steam Web API key is not configured"), { statusCode: 500 });
  return value;
}

async function steamRequest(path: string, params: Record<string, string>) {
  const url = new URL(`https://api.steampowered.com/${path}`);
  url.searchParams.set("key", steamWebApiKey());
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw Object.assign(new Error("Steam Web API is unavailable"), { statusCode: 502 });
  }
  if (!response.ok) throw Object.assign(new Error("Steam Web API rejected the request"), { statusCode: 502 });
  return response.json() as Promise<Record<string, unknown>>;
}

export async function fetchSteamProfile(steamId: string): Promise<SteamProfile> {
  if (!/^\d{17}$/.test(steamId)) throw Object.assign(new Error("Steam ID is invalid"), { statusCode: 400 });
  const payload = await steamRequest("ISteamUser/GetPlayerSummaries/v0002/", { steamids: steamId });
  const response = payload.response as { players?: Array<Record<string, unknown>> } | undefined;
  const player = response?.players?.[0];
  if (!player || typeof player.personaname !== "string") {
    throw Object.assign(new Error("Steam profile was not available"), { statusCode: 502 });
  }
  const avatar = typeof player.avatarfull === "string" ? player.avatarfull : typeof player.avatarmedium === "string" ? player.avatarmedium : typeof player.avatar === "string" ? player.avatar : "";
  return { username: player.personaname, avatar };
}

/**
 * When the Steam account was created (GetPlayerSummaries.timecreated). Steam only returns it for
 * public profiles, so null means "private or unknown" — the profile then hides the row.
 */
export async function fetchSteamAccountCreatedAt(steamId: string): Promise<string | null> {
  if (!/^\d{17}$/.test(steamId)) return null;
  try {
    const payload = await steamRequest("ISteamUser/GetPlayerSummaries/v0002/", { steamids: steamId });
    const player = (payload.response as { players?: Array<Record<string, unknown>> } | undefined)?.players?.[0];
    const created = typeof player?.timecreated === "number" ? player.timecreated : null;
    return created && created > 0 ? new Date(created * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export async function syncSteamUserProfile(steamId: string) {
  const profile = await fetchSteamProfile(steamId);
  const { data, error } = await legacyXDb()
    .from("users")
    .update({ username: profile.username, avatar: profile.avatar })
    .eq("steam_id", steamId)
    .select("id,steam_id,username,avatar,level,rank")
    .maybeSingle();
  legacyXError(error, "Unable to update Steam profile");
  if (!data) throw Object.assign(new Error("Steam user was not found after OpenID verification"), { statusCode: 404 });
  return { profile, user: data };
}

export async function validateSteamWebApiKey() {
  const payload = await steamRequest("ISteamWebAPIUtil/GetServerInfo/v0001/", {});
  if (!payload.response && !payload.servertime) throw Object.assign(new Error("Steam Web API key validation returned an unexpected response"), { statusCode: 502 });
}

export type SteamBanInfo = {
  steamId: string;
  personaName: string | null;
  createdAt: string | null;
  profilePublic: boolean | null;
  vacBanned: boolean;
  gameBans: number;
  communityBanned: boolean;
  economyBan: string;
  daysSinceLastBan: number | null;
};

/**
 * What Steam says about up to 10 accounts: who they are and whether they carry VAC or game bans. One call each for names and
 * bans. Anything wrong (no key, Steam down) gives an empty list: this is extra information, never a reason to fail a report.
 */
export async function fetchSteamBans(steamIds: string[]): Promise<SteamBanInfo[]> {
  const ids = Array.from(new Set(steamIds.filter((id) => /^\d{17}$/.test(id)))).slice(0, 10);
  if (ids.length === 0) return [];
  try {
    const [summaries, bans] = await Promise.all([
      steamRequest("ISteamUser/GetPlayerSummaries/v0002/", { steamids: ids.join(",") }),
      steamRequest("ISteamUser/GetPlayerBans/v1/", { steamids: ids.join(",") }),
    ]);
    const players = ((summaries.response as { players?: Array<Record<string, unknown>> } | undefined)?.players ?? []);
    const banRows = ((bans as { players?: Array<Record<string, unknown>> }).players ?? []);
    return ids.map((steamId) => {
      const player = players.find((row) => row.steamid === steamId);
      const ban = banRows.find((row) => row.SteamId === steamId);
      const created = typeof player?.timecreated === "number" && player.timecreated > 0 ? new Date(player.timecreated * 1000).toISOString() : null;
      return {
        steamId,
        personaName: typeof player?.personaname === "string" ? player.personaname.slice(0, 64) : null,
        createdAt: created,
        profilePublic: typeof player?.communityvisibilitystate === "number" ? player.communityvisibilitystate === 3 : null,
        vacBanned: ban?.VACBanned === true,
        gameBans: typeof ban?.NumberOfGameBans === "number" ? ban.NumberOfGameBans : 0,
        communityBanned: ban?.CommunityBanned === true,
        economyBan: typeof ban?.EconomyBan === "string" ? ban.EconomyBan.slice(0, 20) : "none",
        daysSinceLastBan: typeof ban?.DaysSinceLastBan === "number" && (ban.VACBanned === true || (typeof ban.NumberOfGameBans === "number" && ban.NumberOfGameBans > 0)) ? ban.DaysSinceLastBan : null,
      };
    });
  } catch {
    return [];
  }
}
