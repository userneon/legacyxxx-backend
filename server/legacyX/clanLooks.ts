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
  /** The clan picks the colours itself (stored in clan_look_custom); color, glow, from and to here are the starting values. Costs 50% above the plain item. */
  custom?: boolean;
}


export const CLAN_LOOK_ITEMS: ClanLookItem[] = [
  { id: "tag-crimson", kind: "tag_color", name: "Crimson", price: 150, rarity: 1, color: "#fb7185" },
  { id: "tag-sky", kind: "tag_color", name: "Sky", price: 150, rarity: 1, color: "#7dd3fc" },
  { id: "tag-mint", kind: "tag_color", name: "Mint", price: 150, rarity: 1, color: "#6ee7b7" },
  { id: "tag-amber", kind: "tag_color", name: "Amber", price: 150, rarity: 1, color: "#fcd34d" },
  { id: "tag-violet", kind: "tag_color", name: "Violet", price: 150, rarity: 1, color: "#c4b5fd" },
  { id: "tag-chrome", kind: "tag_color", name: "Chrome", price: 350, rarity: 2, color: "#cbd5e1", fx: "chrome" },
  { id: "tag-glacier", kind: "tag_color", name: "Glacier", price: 350, rarity: 2, color: "#7dd3fc", fx: "ice" },
  { id: "tag-sakura", kind: "tag_color", name: "Sakura", price: 350, rarity: 2, color: "#ff9cbc", fx: "sakura" },
  { id: "tag-emerald", kind: "tag_color", name: "Emerald", price: 350, rarity: 2, color: "#34d399", fx: "emerald" },
  { id: "tag-goldfoil", kind: "tag_color", name: "Gold Foil", price: 500, rarity: 3, color: "#f5c542", fx: "gold" },
  { id: "tag-inferno", kind: "tag_color", name: "Inferno", price: 500, rarity: 3, color: "#ff9100", fx: "fire" },
  { id: "tag-aurora", kind: "tag_color", name: "Aurora", price: 600, rarity: 3, color: "#22d3ee", fx: "aurora" },
  { id: "tag-hologram", kind: "tag_color", name: "Hologram", price: 800, rarity: 4, color: "#a5f3fc", fx: "holo" },
  { id: "glow-neon-rose", kind: "tag_glow", name: "Neon Rose", price: 250, rarity: 1, glow: "#f43f5e", fx: "neon" },
  { id: "glow-neon-ice", kind: "tag_glow", name: "Neon Ice", price: 250, rarity: 1, glow: "#38bdf8", fx: "neon" },
  { id: "glow-neon-lime", kind: "tag_glow", name: "Neon Lime", price: 250, rarity: 1, glow: "#a3e635", fx: "neon" },
  { id: "glow-pulse", kind: "tag_glow", name: "Pulse", price: 400, rarity: 2, glow: "#f43f5e", fx: "pulse" },
  { id: "glow-flame", kind: "tag_glow", name: "Flame", price: 450, rarity: 2, glow: "#fb923c", fx: "flame" },
  { id: "glow-electric", kind: "tag_glow", name: "Electric", price: 450, rarity: 3, glow: "#60a5fa", fx: "electric" },
  { id: "glow-royal", kind: "tag_glow", name: "Royal Aura", price: 600, rarity: 4, glow: "#fbbf24", fx: "aura" },
  { id: "back-ember", kind: "backdrop", name: "Ember", price: 300, rarity: 1, from: "#7f1d1d", to: "#0a0a0a" },
  { id: "back-ocean", kind: "backdrop", name: "Deep Ocean", price: 300, rarity: 1, from: "#0c4a6e", to: "#0a0a0a" },
  { id: "back-forest", kind: "backdrop", name: "Forest", price: 300, rarity: 1, from: "#14532d", to: "#0a0a0a" },
  { id: "back-dusk", kind: "backdrop", name: "Dusk", price: 450, rarity: 2, from: "#4c1d95", to: "#831843" },
  { id: "back-steel", kind: "backdrop", name: "Steel", price: 450, rarity: 2, from: "#334155", to: "#0a0a0a" },
  { id: "back-sunset", kind: "backdrop", name: "Sunset", price: 650, rarity: 3, from: "#9a3412", to: "#701a75" },
  { id: "back-northern", kind: "backdrop", name: "Northern Lights", price: 800, rarity: 4, from: "#0f766e", to: "#4338ca" },
  { id: "back-violet", kind: "backdrop", name: "Violet Night", price: 300, rarity: 1, from: "#3b0764", to: "#0a0a0a" },
  { id: "back-rose", kind: "backdrop", name: "Rose", price: 300, rarity: 1, from: "#9f1239", to: "#0a0a0a" },
  { id: "back-gold", kind: "backdrop", name: "Old Gold", price: 300, rarity: 1, from: "#854d0e", to: "#0a0a0a" },
  { id: "back-teal", kind: "backdrop", name: "Teal", price: 300, rarity: 1, from: "#115e59", to: "#0a0a0a" },
  { id: "back-slate-blue", kind: "backdrop", name: "Midnight", price: 450, rarity: 2, from: "#1e3a8a", to: "#0f172a" },
  { id: "back-toxic", kind: "backdrop", name: "Moss", price: 450, rarity: 2, from: "#3f6212", to: "#052e16" },
  { id: "back-blood", kind: "backdrop", name: "Garnet Moon", price: 450, rarity: 2, from: "#991b1b", to: "#1c1917" },
  { id: "back-candy", kind: "backdrop", name: "Candy", price: 650, rarity: 3, from: "#be185d", to: "#6d28d9" },
  { id: "back-lava", kind: "backdrop", name: "Lava", price: 650, rarity: 3, from: "#c2410c", to: "#7f1d1d" },
  { id: "back-glacier", kind: "backdrop", name: "Glacier", price: 650, rarity: 3, from: "#0e7490", to: "#1e40af" },
  { id: "back-royal", kind: "backdrop", name: "Royal", price: 800, rarity: 4, from: "#6d28d9", to: "#b45309" },
  { id: "back-nebula", kind: "backdrop", name: "Nebula", price: 800, rarity: 4, from: "#be185d", to: "#0e7490" },
  { id: "tag-custom", kind: "tag_color", name: "Custom colour", price: 225, rarity: 3, color: "#c4b5fd", custom: true },
  { id: "clan-glow-custom", kind: "tag_glow", name: "Custom glow", price: 375, rarity: 3, glow: "#8b5cf6", fx: "neon", custom: true },
  { id: "back-custom", kind: "backdrop", name: "Custom gradient", price: 450, rarity: 3, from: "#4c1d95", to: "#0a0a0a", custom: true },
  { id: "page-custom-slats", kind: "page", name: "Custom Micro Slats", price: 2250, rarity: 4, from: "#cbd5e1", to: "#0a0a0a", effect: "slats", custom: true },
  { id: "page-custom-waves", kind: "page", name: "Custom Pattern Waves", price: 2250, rarity: 4, from: "#e5e5e5", to: "#0a0a0a", effect: "waves", custom: true },
  { id: "page-custom-dots", kind: "page", name: "Custom Dot Field", price: 1950, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "dots", custom: true },
  { id: "page-custom-aurora", kind: "page", name: "Custom Aurora Veil", price: 2100, rarity: 4, from: "#6ee7b7", to: "#0a0a0a", effect: "aurora", custom: true },
  { id: "page-custom-threads", kind: "page", name: "Custom Silk Threads", price: 1950, rarity: 4, from: "#6ee7b7", to: "#0a0a0a", effect: "threads", custom: true },
  { id: "page-custom-particles", kind: "page", name: "Custom Star Dust", price: 1950, rarity: 4, from: "#fcd34d", to: "#0a0a0a", effect: "particles", custom: true },
  { id: "page-custom-lightning", kind: "page", name: "Custom Lightning", price: 2250, rarity: 4, from: "#7dd3fc", to: "#0a0a0a", effect: "lightning", custom: true },
  { id: "page-custom-rays", kind: "page", name: "Custom Light Rays", price: 2100, rarity: 4, from: "#e5e5e5", to: "#0a0a0a", effect: "rays", custom: true },
  { id: "page-custom-lines", kind: "page", name: "Custom Wave Lines", price: 1650, rarity: 4, from: "#fb7185", to: "#0a0a0a", effect: "lines", custom: true },
  { id: "page-custom-plasma", kind: "page", name: "Custom Plasma", price: 2250, rarity: 4, from: "#fb923c", to: "#0a0a0a", effect: "plasma", custom: true },
  { id: "page-custom-starfield", kind: "page", name: "Custom Warp Speed", price: 2250, rarity: 4, from: "#7dd3fc", to: "#0a0a0a", effect: "starfield", custom: true },
  { id: "page-custom-matrix", kind: "page", name: "Custom Code Rain", price: 2100, rarity: 4, from: "#4ade80", to: "#0a0a0a", effect: "matrix", custom: true },
  { id: "page-custom-orbs", kind: "page", name: "Custom Lava Lamp", price: 1950, rarity: 4, from: "#8b5cf6", to: "#0a0a0a", effect: "orbs", custom: true },
  { id: "page-custom-grid", kind: "page", name: "Custom Retro Grid", price: 2250, rarity: 4, from: "#f472b6", to: "#0a0a0a", effect: "grid", custom: true },
  { id: "page-custom-embers", kind: "page", name: "Custom Embers", price: 2100, rarity: 4, from: "#fb923c", to: "#0a0a0a", effect: "embers", custom: true },
  { id: "page-custom-vortex", kind: "page", name: "Custom Galaxy", price: 2400, rarity: 4, from: "#c084fc", to: "#0a0a0a", effect: "vortex", custom: true },
  { id: "page-custom-hex", kind: "page", name: "Custom Honeycomb", price: 1950, rarity: 4, from: "#6ee7b7", to: "#0a0a0a", effect: "hex", custom: true },
  { id: "page-slats-silver", kind: "page", name: "Micro Slats Silver", price: 1500, rarity: 4, from: "#cbd5e1", to: "#0a0a0a", effect: "slats" },
  { id: "page-slats-rose", kind: "page", name: "Micro Slats Rose", price: 1500, rarity: 4, from: "#fb7185", to: "#0a0a0a", effect: "slats" },
  { id: "page-slats-ocean", kind: "page", name: "Micro Slats Ocean", price: 1500, rarity: 4, from: "#38bdf8", to: "#0a0a0a", effect: "slats" },
  { id: "page-waves-silver", kind: "page", name: "Pattern Waves Silver", price: 1500, rarity: 4, from: "#e5e5e5", to: "#0a0a0a", effect: "waves" },
  { id: "page-waves-ember", kind: "page", name: "Pattern Waves Ember", price: 1500, rarity: 4, from: "#fb923c", to: "#0a0a0a", effect: "waves" },
  { id: "page-waves-mint", kind: "page", name: "Pattern Waves Mint", price: 1500, rarity: 4, from: "#6ee7b7", to: "#0a0a0a", effect: "waves" },
  { id: "page-dots-silver", kind: "page", name: "Dot Field Silver", price: 1300, rarity: 4, from: "#d4d4d4", to: "#0a0a0a", effect: "dots" },
  { id: "page-dots-rose", kind: "page", name: "Dot Field Rose", price: 1300, rarity: 4, from: "#fb7185", to: "#0a0a0a", effect: "dots" },
  { id: "page-dots-gold", kind: "page", name: "Dot Field Gold", price: 1300, rarity: 4, from: "#fcd34d", to: "#0a0a0a", effect: "dots" },
  { id: "page-aurora-rose", kind: "page", name: "Aurora Veil Rose", price: 1400, rarity: 4, from: "#fb7185", to: "#0a0a0a", effect: "aurora" },
  { id: "page-aurora-mint", kind: "page", name: "Aurora Veil Mint", price: 1400, rarity: 4, from: "#6ee7b7", to: "#0a0a0a", effect: "aurora" },
  { id: "page-threads-mint", kind: "page", name: "Silk Threads Mint", price: 1300, rarity: 4, from: "#6ee7b7", to: "#0a0a0a", effect: "threads" },
  { id: "page-threads-gold", kind: "page", name: "Silk Threads Gold", price: 1300, rarity: 4, from: "#fcd34d", to: "#0a0a0a", effect: "threads" },
  { id: "page-particles-gold", kind: "page", name: "Star Dust Gold", price: 1300, rarity: 4, from: "#fcd34d", to: "#0a0a0a", effect: "particles" },
  { id: "page-particles-ice", kind: "page", name: "Star Dust Ice", price: 1300, rarity: 4, from: "#7dd3fc", to: "#0a0a0a", effect: "particles" },
  { id: "page-lightning-ember", kind: "page", name: "Lightning Ember", price: 1500, rarity: 4, from: "#fb923c", to: "#0a0a0a", effect: "lightning" },
  { id: "page-lightning-ice", kind: "page", name: "Lightning Ice", price: 1500, rarity: 4, from: "#7dd3fc", to: "#0a0a0a", effect: "lightning" },
  { id: "page-rays-silver", kind: "page", name: "Light Rays Silver", price: 1400, rarity: 4, from: "#e5e5e5", to: "#0a0a0a", effect: "rays" },
  { id: "page-rays-gold", kind: "page", name: "Light Rays Gold", price: 1400, rarity: 4, from: "#fcd34d", to: "#0a0a0a", effect: "rays" },
  { id: "page-lines-rose", kind: "page", name: "Wave Lines Rose", price: 1100, rarity: 4, from: "#fb7185", to: "#0a0a0a", effect: "lines" },
  { id: "page-lines-mint", kind: "page", name: "Wave Lines Mint", price: 1100, rarity: 4, from: "#6ee7b7", to: "#0a0a0a", effect: "lines" },
  { id: "page-plasma-ember", kind: "page", name: "Plasma Ember", price: 1500, rarity: 4, from: "#fb923c", to: "#0a0a0a", effect: "plasma" },
  { id: "page-plasma-rose", kind: "page", name: "Plasma Rose", price: 1500, rarity: 4, from: "#fb7185", to: "#0a0a0a", effect: "plasma" },
  // More animated backgrounds (owner request 2026-10-26); the plain gradients were taken out the same day, every page background now moves.
  { id: "page-starfield-ice", kind: "page", name: "Warp Speed Ice", price: 1500, rarity: 4, from: "#7dd3fc", to: "#0a0a0a", effect: "starfield" },
  { id: "page-starfield-violet", kind: "page", name: "Warp Speed Violet", price: 1500, rarity: 4, from: "#a78bfa", to: "#0a0a0a", effect: "starfield" },
  { id: "page-matrix-green", kind: "page", name: "Code Rain", price: 1400, rarity: 4, from: "#4ade80", to: "#0a0a0a", effect: "matrix" },
  { id: "page-matrix-red", kind: "page", name: "Code Rain Red", price: 1400, rarity: 4, from: "#f87171", to: "#0a0a0a", effect: "matrix" },
  { id: "page-orbs-violet", kind: "page", name: "Lava Lamp Violet", price: 1300, rarity: 4, from: "#8b5cf6", to: "#0a0a0a", effect: "orbs" },
  { id: "page-orbs-sunset", kind: "page", name: "Lava Lamp Sunset", price: 1300, rarity: 4, from: "#fb923c", to: "#0a0a0a", effect: "orbs" },
  { id: "page-grid-pink", kind: "page", name: "Retro Grid Pink", price: 1500, rarity: 4, from: "#f472b6", to: "#0a0a0a", effect: "grid" },
  { id: "page-grid-cyan", kind: "page", name: "Retro Grid Cyan", price: 1500, rarity: 4, from: "#22d3ee", to: "#0a0a0a", effect: "grid" },
  { id: "page-embers-fire", kind: "page", name: "Embers", price: 1400, rarity: 4, from: "#fb923c", to: "#0a0a0a", effect: "embers" },
  { id: "page-embers-gold", kind: "page", name: "Embers Gold", price: 1400, rarity: 4, from: "#fcd34d", to: "#0a0a0a", effect: "embers" },
  { id: "page-vortex-violet", kind: "page", name: "Galaxy Violet", price: 1600, rarity: 4, from: "#c084fc", to: "#0a0a0a", effect: "vortex" },
  { id: "page-vortex-ice", kind: "page", name: "Galaxy Ice", price: 1600, rarity: 4, from: "#7dd3fc", to: "#0a0a0a", effect: "vortex" },
  { id: "page-hex-mint", kind: "page", name: "Honeycomb Mint", price: 1300, rarity: 4, from: "#6ee7b7", to: "#0a0a0a", effect: "hex" },
  { id: "page-hex-gold", kind: "page", name: "Honeycomb Gold", price: 1300, rarity: 4, from: "#fcd34d", to: "#0a0a0a", effect: "hex" },
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
