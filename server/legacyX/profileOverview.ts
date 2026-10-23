/**
 * Profile page aggregation: what a viewer may see, derived stats, per-map win rates and the loadout
 * showcase. Pure functions; routes.ts loads the rows. Hiding happens here, server-side — a hidden
 * section is omitted from the response, not just from the UI.
 */

type Row = Record<string, any>;

/** "What others can see" switches (users.hidden_profile_sections). */
export const PROFILE_SECTIONS = ["stats", "matches", "faceit", "loadout"] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** Older values written before the redesign map onto the four sections. */
const LEGACY_SECTIONS: Record<string, ProfileSection> = { kd: "stats", kills: "stats", matches: "stats", recent_matches: "matches", faceit: "faceit" };

export function normalizeHiddenSections(value: unknown): ProfileSection[] {
  if (!Array.isArray(value)) return [];
  const hidden = new Set<ProfileSection>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    if ((PROFILE_SECTIONS as readonly string[]).includes(raw)) hidden.add(raw as ProfileSection);
    else if (LEGACY_SECTIONS[raw]) hidden.add(LEGACY_SECTIONS[raw]);
  }
  return PROFILE_SECTIONS.filter((section) => hidden.has(section));
}

/** The owner and staff always see everything. */
export function hiddenForViewer(hidden: ProfileSection[], viewer: { isOwner: boolean; isStaff: boolean }) {
  return viewer.isOwner || viewer.isStaff ? [] : hidden;
}

/** null / missing stay NaN so a tile without data is dropped instead of showing 0. */
const num = (value: unknown) => (value === null || value === undefined || value === "" ? Number.NaN : Number(value));

export type StatKey = "matches" | "winRate" | "kd" | "hs" | "avgKills";
export const BENCHMARK_MIN_MATCHES = 5;
export const BENCHMARK_MIN_PLAYERS = 10;

/** The raw (unrounded) numbers behind one player's tiles; a key is missing when its data doesn't exist. */
function rawStats(progression: Row): Partial<Record<StatKey, number>> {
  const matches = num(progression.matches_completed) || 0;
  const out: Partial<Record<StatKey, number>> = {};
  if (matches <= 0) return out;
  const kills = num(progression.kills);
  const deaths = num(progression.deaths);
  const headshots = num(progression.headshot_kills);
  const wins = num(progression.wins) || 0;
  out.matches = matches;
  out.winRate = (wins / matches) * 100;
  if (Number.isFinite(kills) && Number.isFinite(deaths) && deaths > 0) out.kd = kills / deaths;
  if (Number.isFinite(kills) && Number.isFinite(headshots) && kills > 0) out.hs = (headshots / kills) * 100;
  if (Number.isFinite(kills)) out.avgKills = kills / matches;
  return out;
}

/** How the community stands: every player with at least BENCHMARK_MIN_MATCHES ranked matches, one sorted list per stat. */
export type StatBenchmark = { players: number; values: Record<StatKey, number[]> };

export function buildBenchmark(rows: Row[]): StatBenchmark {
  const values: Record<StatKey, number[]> = { matches: [], winRate: [], kd: [], hs: [], avgKills: [] };
  let players = 0;
  for (const row of rows) {
    if ((num(row.matches_completed) || 0) < BENCHMARK_MIN_MATCHES) continue;
    players += 1;
    const raw = rawStats(row);
    for (const key of Object.keys(values) as StatKey[]) {
      const value = raw[key];
      if (value !== undefined && Number.isFinite(value)) values[key].push(value);
    }
  }
  for (const key of Object.keys(values) as StatKey[]) values[key].sort((a, b) => a - b);
  return { players, values };
}

const DECIMALS: Record<StatKey, number> = { matches: 0, winRate: 0, kd: 2, hs: 0, avgKills: 1 };
const roundTo = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/** Share (0-100) of the benchmark with a lower value, ties counting half. */
function percentileOf(sorted: number[], value: number) {
  if (sorted.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const item of sorted) {
    if (item < value) below += 1;
    else if (item === value) equal += 1;
  }
  return Math.round(((below + equal / 2) / sorted.length) * 100);
}

/**
 * Stat tiles from competitive progression; a tile is dropped when its data doesn't exist. With a benchmark of at least BENCHMARK_MIN_PLAYERS
 * players each tile also carries `average` (the community's), and `percentile` (how many players it beats) once the player has
 * BENCHMARK_MIN_MATCHES matches of their own. Nothing is guessed: with too few players both stay null.
 */
export function profileStats(progression: Row | null, benchmark?: StatBenchmark | null) {
  if (!progression) return null;
  const matches = num(progression.matches_completed) || 0;
  if (matches <= 0) return null;
  const raw = rawStats(progression);
  const labels: Record<StatKey, string> = { matches: "Matches", winRate: "Win rate", kd: "K/D", hs: "HS %", avgKills: "Avg kills" };
  const useBenchmark = benchmark != null && benchmark.players >= BENCHMARK_MIN_PLAYERS;
  const ranked = matches >= BENCHMARK_MIN_MATCHES;
  const tiles: { key: StatKey; label: string; value: number; average: number | null; percentile: number | null }[] = [];
  for (const key of ["matches", "winRate", "kd", "hs", "avgKills"] as StatKey[]) {
    const value = raw[key];
    if (value === undefined) continue;
    const list = useBenchmark ? benchmark.values[key] : [];
    const average = list.length > 0 ? roundTo(list.reduce((sum, item) => sum + item, 0) / list.length, DECIMALS[key]) : null;
    tiles.push({ key, label: labels[key], value: roundTo(value, DECIMALS[key]), average, percentile: ranked && list.length > 0 ? percentileOf(list, value) : null });
  }
  return tiles;
}

/** Win rate per map from ranked history, maps with at least `minMatches` games, best first. */
export function mapWinRates(rows: Row[], minMatches = 3) {
  const byMap = new Map<string, { matches: number; wins: number }>();
  for (const row of rows) {
    const core = (Array.isArray(row.core_matches) ? row.core_matches[0] : row.core_matches) ?? {};
    const map = String(core.map_name ?? row.map ?? "").trim();
    if (!map) continue;
    const entry = byMap.get(map) ?? { matches: 0, wins: 0 };
    entry.matches += 1;
    if (row.outcome === "win") entry.wins += 1;
    byMap.set(map, entry);
  }
  return Array.from(byMap.entries())
    .filter(([, entry]) => entry.matches >= minMatches)
    .map(([map, entry]) => ({ map, matches: entry.matches, wins: entry.wins, winRate: Math.round((entry.wins / entry.matches) * 100) }))
    .sort((a, b) => b.winRate - a.winRate || b.matches - a.matches || a.map.localeCompare(b.map));
}

const SHOWCASE: { key: "knife" | "glove" | "ak47" | "awp"; label: string; matches: (entry: Row, item: Row) => boolean }[] = [
  { key: "knife", label: "Knife", matches: (entry) => entry.slot === "knife" },
  { key: "glove", label: "Gloves", matches: (entry) => entry.slot === "glove" },
  { key: "ak47", label: "AK-47", matches: (entry, item) => entry.slot === "weapon" && /^ak-?47$/i.test(String(item.weapon_class ?? "")) },
  { key: "awp", label: "AWP", matches: (entry, item) => entry.slot === "weapon" && /^awp$/i.test(String(item.weapon_class ?? "")) },
];

/**
 * Knife, gloves, AK-47 and AWP for the side with the most equipped skins ("Both" looks count for
 * either side). Null when nothing is equipped.
 */
export function loadoutShowcase(entries: Row[]) {
  const withItem = entries.filter((entry) => entry.skinchanger_catalog_items);
  if (withItem.length === 0) return null;
  const count = (side: "t" | "ct") => withItem.filter((entry) => entry.team_scope === side || entry.team_scope === "all").length;
  const side: "t" | "ct" = count("ct") > count("t") ? "ct" : "t";
  const forSide = (entry: Row) => entry.team_scope === side || entry.team_scope === "all";
  const items = SHOWCASE.map((slot) => {
    const candidates = withItem.filter((entry) => forSide(entry) && slot.matches(entry, entry.skinchanger_catalog_items));
    // An exact-side look wins over a "Both" look.
    const entry = candidates.find((candidate) => candidate.team_scope === side) ?? candidates[0];
    const item = entry?.skinchanger_catalog_items as Row | undefined;
    return { key: slot.key, label: slot.label, name: item ? String(item.display_name ?? "") : null, image: item ? (item.image_url ?? null) : null };
  });
  if (items.every((item) => !item.name)) return null;
  return { side, items };
}

const ROLE_BLURB: Record<string, string> = {
  Owner: "Runs the servers and the community.",
  Founder: "Founded LEGACY-X.",
  Manager: "Keeps staff and events running.",
  Admin: "Moderates matches and handles reports.",
  Developer: "Builds the website, plugins and bots.",
  Designer: "Designs the website and community art.",
};

export function staffCard(role: string, penaltiesIssued: number) {
  if (!role || role === "Player") return null;
  return { role, description: ROLE_BLURB[role] ?? "Part of the LEGACY-X team.", penaltiesIssued };
}

/** A profile address that is a player's name: not "me", not a SteamID64, not a user ID. */
export const PROFILE_NAME_MAX = 64;

/** `%`, `_` and `\` mean something to ILIKE; a name has to match literally. */
export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Names are not unique (they come from Steam), so a name address opens the best-ranked player of that name, and
 * among unranked ones the oldest account. `positions` maps user ID → leaderboard position.
 */
export function bestNameMatch(rows: Row[], positions: Map<string, number>): string | null {
  const ranked = (row: Row) => positions.get(String(row.id)) ?? Number.POSITIVE_INFINITY;
  const sorted = [...rows].sort((a, b) => ranked(a) - ranked(b) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  return sorted[0] ? String(sorted[0].id) : null;
}
