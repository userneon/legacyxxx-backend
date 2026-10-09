import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Clan appearance. Purely visual. The leader buys with coins, the clan owns it, and every member's clan shows it.
 * Colours are #rrggbb and effect keys are ones the website knows; anything else is never sent.
 */
export type ClanLookKind = "tag_color" | "tag_glow" | "backdrop";
export const CLAN_LOOK_KINDS = ["tag_color", "tag_glow", "backdrop"] as const;

export interface ClanLookItem {
  id: string;
  kind: ClanLookKind;
  name: string;
  price: number;
  rarity: 1 | 2 | 3 | 4;
  /** tag_color: base colour and optional effect. tag_glow: glow colour and effect. backdrop: two colours of the gradient. */
  color?: string;
  glow?: string;
  fx?: string;
  from?: string;
  to?: string;
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
  { id: "back-toxic", kind: "backdrop", name: "Toxic", price: 450, rarity: 2, from: "#3f6212", to: "#052e16" },
  { id: "back-blood", kind: "backdrop", name: "Blood Moon", price: 450, rarity: 2, from: "#991b1b", to: "#1c1917" },
  { id: "back-candy", kind: "backdrop", name: "Candy", price: 650, rarity: 3, from: "#be185d", to: "#6d28d9" },
  { id: "back-lava", kind: "backdrop", name: "Lava", price: 650, rarity: 3, from: "#c2410c", to: "#7f1d1d" },
  { id: "back-glacier", kind: "backdrop", name: "Glacier", price: 650, rarity: 3, from: "#0e7490", to: "#1e40af" },
  { id: "back-royal", kind: "backdrop", name: "Royal", price: 800, rarity: 4, from: "#6d28d9", to: "#b45309" },
  { id: "back-nebula", kind: "backdrop", name: "Nebula", price: 800, rarity: 4, from: "#be185d", to: "#0e7490" },
];

const ITEM_BY_ID = new Map(CLAN_LOOK_ITEMS.map((item) => [item.id, item]));
export const clanLookItem = (id: string) => ITEM_BY_ID.get(id);

export interface ClanLook {
  tagColor: string | null;
  tagColorFx: string | null;
  tagGlow: string | null;
  tagGlowFx: string | null;
  backdrop: { from: string; to: string } | null;
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
  for (const row of (data ?? []) as Array<{ clan_id: string; kind: string; item_id: string }>) {
    const item = clanLookItem(row.item_id);
    if (!item || item.kind !== row.kind) continue;
    const look = looks.get(row.clan_id) ?? { tagColor: null, tagColorFx: null, tagGlow: null, tagGlowFx: null, backdrop: null };
    if (item.kind === "tag_color") { look.tagColor = item.color ?? null; look.tagColorFx = item.fx ?? null; }
    if (item.kind === "tag_glow") { look.tagGlow = item.glow ?? null; look.tagGlowFx = item.fx ?? null; }
    if (item.kind === "backdrop" && item.from && item.to) look.backdrop = { from: item.from, to: item.to };
    looks.set(row.clan_id, look);
  }
  return looks;
}
