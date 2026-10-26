import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Clan appearance. Purely visual. The leader buys with LX, the clan owns it, and every member's clan shows it.
 * Colours are #rrggbb and effect keys are ones the website knows; anything else is never sent.
 */
export type ClanPageEffect = "slats" | "waves" | "dots" | "aurora" | "threads" | "particles" | "lightning" | "rays" | "lines" | "plasma" | "starfield" | "matrix" | "orbs" | "grid" | "embers" | "vortex" | "hex";
export type ClanLookKind = "tag_color" | "tag_glow" | "backdrop" | "page";
export const CLAN_LOOK_KINDS = ["tag_color", "tag_glow", "backdrop", "page"] as const;

export interface ClanLookItem {
  id: string;
  kind: ClanLookKind;
  name: string;
  price: number;
  rarity: 1 | 2 | 3 | 4;
  /** tag_color: base colour and optional effect. tag_glow: glow colour and effect. backdrop and page: two colours of the gradient (a backdrop paints the clan's header and cards, a page paints the whole clan page). */
  color?: string;
  glow?: string;
  fx?: string;
  from?: string;
  to?: string;
  /** page only: an animated background (from is its colour, to the base). */
  effect?: ClanPageEffect;
  /** The clan picks the colours itself (stored in clan_look_custom); color, glow, from and to here are the neutral starting values. Every item is one now. */
  custom?: boolean;
}


export const CLAN_LOOK_ITEMS: ClanLookItem[] = [
  // Colour it yourself (owner request 2026-10-26): one item per design, the clan picks its colours (clan_look_custom); grey until it does.
  { id: "tag-custom", kind: "tag_color", name: "Solid", price: 150, rarity: 1, color: "#d4d4d4", custom: true },
  { id: "tag-gradient", kind: "tag_color", name: "Gradient", price: 350, rarity: 2, color: "#d4d4d4", fx: "gradient", custom: true },
  { id: "tag-chrome", kind: "tag_color", name: "Chrome", price: 350, rarity: 2, color: "#d4d4d4", fx: "chrome", custom: true },
  { id: "tag-inferno", kind: "tag_color", name: "Fire", price: 500, rarity: 3, color: "#d4d4d4", fx: "fire", custom: true },
  { id: "tag-goldfoil", kind: "tag_color", name: "Foil", price: 500, rarity: 3, color: "#d4d4d4", fx: "foil", custom: true },
  { id: "tag-aurora", kind: "tag_color", name: "Drift", price: 600, rarity: 4, color: "#d4d4d4", fx: "drift", custom: true },
  { id: "clan-glow-custom", kind: "tag_glow", name: "Neon", price: 250, rarity: 1, glow: "#d4d4d4", fx: "neon", custom: true },
  { id: "clan-glow-halo", kind: "tag_glow", name: "Halo", price: 250, rarity: 1, glow: "#d4d4d4", fx: "halo", custom: true },
  { id: "clan-glow-breathe", kind: "tag_glow", name: "Breathe", price: 350, rarity: 2, glow: "#d4d4d4", fx: "breathe", custom: true },
  { id: "glow-pulse", kind: "tag_glow", name: "Pulse", price: 400, rarity: 2, glow: "#d4d4d4", fx: "pulse", custom: true },
  { id: "clan-glow-spark", kind: "tag_glow", name: "Spark", price: 400, rarity: 2, glow: "#d4d4d4", fx: "spark", custom: true },
  { id: "glow-flame", kind: "tag_glow", name: "Flame", price: 450, rarity: 3, glow: "#d4d4d4", fx: "flame", custom: true },
  { id: "glow-electric", kind: "tag_glow", name: "Electric", price: 450, rarity: 3, glow: "#d4d4d4", fx: "electric", custom: true },
  { id: "glow-royal", kind: "tag_glow", name: "Aura", price: 600, rarity: 4, glow: "#d4d4d4", fx: "aura", custom: true },
  { id: "back-custom", kind: "backdrop", name: "Gradient", price: 300, rarity: 2, from: "#d4d4d4", to: "#0a0a0a", custom: true },
  { id: "page-custom-slats", kind: "page", name: "Micro Slats", price: 1500, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "slats", custom: true },
  { id: "page-custom-waves", kind: "page", name: "Pattern Waves", price: 1500, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "waves", custom: true },
  { id: "page-custom-dots", kind: "page", name: "Dot Field", price: 1300, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "dots", custom: true },
  { id: "page-custom-aurora", kind: "page", name: "Aurora Veil", price: 1400, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "aurora", custom: true },
  { id: "page-custom-threads", kind: "page", name: "Silk Threads", price: 1300, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "threads", custom: true },
  { id: "page-custom-particles", kind: "page", name: "Star Dust", price: 1300, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "particles", custom: true },
  { id: "page-custom-lightning", kind: "page", name: "Lightning", price: 1500, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "lightning", custom: true },
  { id: "page-custom-rays", kind: "page", name: "Light Rays", price: 1400, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "rays", custom: true },
  { id: "page-custom-lines", kind: "page", name: "Wave Lines", price: 1100, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "lines", custom: true },
  { id: "page-custom-plasma", kind: "page", name: "Plasma", price: 1500, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "plasma", custom: true },
  { id: "page-custom-starfield", kind: "page", name: "Warp Speed", price: 1500, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "starfield", custom: true },
  { id: "page-custom-matrix", kind: "page", name: "Code Rain", price: 1400, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "matrix", custom: true },
  { id: "page-custom-orbs", kind: "page", name: "Lava Lamp", price: 1300, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "orbs", custom: true },
  { id: "page-custom-grid", kind: "page", name: "Retro Grid", price: 1500, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "grid", custom: true },
  { id: "page-custom-embers", kind: "page", name: "Embers", price: 1400, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "embers", custom: true },
  { id: "page-custom-vortex", kind: "page", name: "Galaxy", price: 1600, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "vortex", custom: true },
  { id: "page-custom-hex", kind: "page", name: "Honeycomb", price: 1300, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "hex", custom: true },
];

const ITEM_BY_ID = new Map(CLAN_LOOK_ITEMS.map((item) => [item.id, item]));
export const clanLookItem = (id: string) => ITEM_BY_ID.get(id);

export interface ClanLook {
  tagColor: string | null;
  tagColorFx: string | null;
  tagGlow: string | null;
  tagGlowFx: string | null;
  backdrop: { from: string; to: string } | null;
  page: { from: string; to: string; effect: ClanPageEffect | null } | null;
}

/** What each clan wears, for any number of clans in one query. A clan that wears nothing is absent from the map. */
export async function clanLooksFor(db: SupabaseClient, clanIds: string[]): Promise<Map<string, ClanLook>> {
  const looks = new Map<string, ClanLook>();
  if (clanIds.length === 0) return looks;
  const { data, error } = await db.from("clan_look_equipped").select("clan_id,kind,item_id").in("clan_id", clanIds);
  if (error) {
    // Looks are decoration: if they cannot be read the clan still shows.
    console.error("[legacy-x-api] unable to load clan looks", error.message);
    return looks;
  }
  const customWorn: Array<{ clanId: string; itemId: string }> = [];
  for (const row of (data ?? []) as Array<{ clan_id: string; kind: string; item_id: string }>) {
    const item = clanLookItem(row.item_id);
    if (!item || item.kind !== row.kind) continue;
    const look = looks.get(row.clan_id) ?? { tagColor: null, tagColorFx: null, tagGlow: null, tagGlowFx: null, backdrop: null, page: null };
    if (item.kind === "tag_color") { look.tagColor = item.color ?? null; look.tagColorFx = item.fx ?? null; }
    if (item.kind === "tag_glow") { look.tagGlow = item.glow ?? null; look.tagGlowFx = item.fx ?? null; }
    if (item.kind === "backdrop" && item.from && item.to) look.backdrop = { from: item.from, to: item.to };
    if (item.kind === "page" && item.from && item.to) look.page = { from: item.from, to: item.to, effect: item.effect ?? null };
    if (item.custom) customWorn.push({ clanId: row.clan_id, itemId: item.id });
    looks.set(row.clan_id, look);
  }
  // A clan wearing a custom item shows the colours it picked; until it picks any, the item's starting colours.
  if (customWorn.length > 0) {
    const { data: picked, error: pickedError } = await db.from("clan_look_custom").select("clan_id,item_id,color_a,color_b").in("clan_id", customWorn.map((entry) => entry.clanId));
    if (pickedError) console.error("[legacy-x-api] unable to load custom clan looks", pickedError.message);
    for (const row of (picked ?? []) as Array<{ clan_id: string; item_id: string; color_a: string; color_b: string | null }>) {
      if (!customWorn.some((entry) => entry.clanId === row.clan_id && entry.itemId === row.item_id)) continue;
      const item = clanLookItem(row.item_id);
      const look = looks.get(row.clan_id);
      if (!item || !look) continue;
      if (item.kind === "tag_color") look.tagColor = row.color_a;
      if (item.kind === "tag_glow") look.tagGlow = row.color_a;
      if (item.kind === "backdrop" && row.color_b) look.backdrop = { from: row.color_a, to: row.color_b };
      if (item.kind === "page" && row.color_b) look.page = { from: row.color_a, to: row.color_b, effect: item.effect ?? null };
    }
  }
  return looks;
}
