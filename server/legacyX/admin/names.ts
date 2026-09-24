import { legacyXDb, legacyXError } from "../supabase";

type Filter = { pattern: string; match_type: "exact" | "contains" | "regex"; action: "flag" | "block" };
let cached: { at: number; filters: Filter[] } | null = null;
const cacheMs = 60_000;

export function invalidateNameFilters() {
  cached = null;
}

async function activeFilters() {
  if (cached && Date.now() - cached.at < cacheMs) return cached.filters;
  const { data, error } = await legacyXDb().from("name_filters").select("pattern,match_type,action").eq("is_active", true);
  legacyXError(error, "Unable to load the name filter");
  cached = { at: Date.now(), filters: (data ?? []) as Filter[] };
  return cached.filters;
}

export function matchesFilter(name: string, filter: Filter) {
  const value = name.toLowerCase();
  const pattern = filter.pattern.toLowerCase();
  if (filter.match_type === "exact") return value === pattern;
  if (filter.match_type === "contains") return value.includes(pattern);
  try {
    return new RegExp(filter.pattern, "i").test(name.slice(0, 64));
  } catch {
    return false;
  }
}

/** block wins over flag. */
export async function checkName(name: string): Promise<{ action: "allow" | "flag" | "block"; pattern?: string }> {
  let verdict: { action: "allow" | "flag" | "block"; pattern?: string } = { action: "allow" };
  for (const filter of await activeFilters()) {
    if (!matchesFilter(name, filter)) continue;
    if (filter.action === "block") return { action: "block", pattern: filter.pattern };
    verdict = { action: "flag", pattern: filter.pattern };
  }
  return verdict;
}

export async function recordName(steamId: string, name: string, serverId: string) {
  const db = legacyXDb();
  const now = new Date().toISOString();
  const { data, error } = await db.from("player_name_history").select("id,times_seen").eq("steam_id", steamId).eq("name", name).maybeSingle();
  legacyXError(error, "Unable to read name history");
  if (data) {
    const { error: updateError } = await db.from("player_name_history").update({ last_seen_at: now, times_seen: Number(data.times_seen) + 1, last_server_id: serverId }).eq("id", data.id);
    legacyXError(updateError, "Unable to update name history");
    return;
  }
  const { error: insertError } = await db.from("player_name_history").insert({ steam_id: steamId, name, last_server_id: serverId });
  // A concurrent insert of the same name is fine.
  if (insertError && insertError.code !== "23505") legacyXError(insertError, "Unable to record name history");
}
