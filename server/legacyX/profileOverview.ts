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

/** Stat tiles from competitive progression; a tile is dropped when its data doesn't exist. */
export function profileStats(progression: Row | null) {
  if (!progression) return null;
  const matches = num(progression.matches_completed) || 0;
  if (matches <= 0) return null;
  const kills = num(progression.kills);
  const deaths = num(progression.deaths);
  const headshots = num(progression.headshot_kills);
  const wins = num(progression.wins) || 0;
  const tiles: { key: "matches" | "winRate" | "kd" | "hs" | "avgKills"; label: string; value: number }[] = [
    { key: "matches", label: "Matches", value: matches },
    { key: "winRate", label: "Win rate", value: Math.round((wins / matches) * 100) },
  ];
  if (Number.isFinite(kills) && Number.isFinite(deaths) && deaths > 0) tiles.push({ key: "kd", label: "K/D", value: Math.round((kills / deaths) * 100) / 100 });
  if (Number.isFinite(kills) && Number.isFinite(headshots) && kills > 0) tiles.push({ key: "hs", label: "HS %", value: Math.round((headshots / kills) * 100) });
  if (Number.isFinite(kills)) tiles.push({ key: "avgKills", label: "Avg kills", value: Math.round((kills / matches) * 10) / 10 });
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
  Founder: "Founded Legacy-X.",
  Manager: "Keeps staff and events running.",
  Admin: "Moderates matches and handles reports.",
  Developer: "Builds the website, plugins and bots.",
  Designer: "Designs the website and community art.",
};

export function staffCard(role: string, penaltiesIssued: number) {
  if (!role || role === "Player") return null;
  return { role, description: ROLE_BLURB[role] ?? "Part of the Legacy-X team.", penaltiesIssued };
}
