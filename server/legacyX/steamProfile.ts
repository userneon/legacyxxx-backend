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
