/**
 * Colour it yourself (owner request 2026-10-26): every cosmetic with a colour is sold as a design only, and the player picks its
 * colour (two for the dual smoke). Until they pick, it shows in a neutral grey. A design whose look is its own colours (the
 * rainbow trail, the prism flash, the spectrum name) stays fixed, and so do earned items.
 */
export const PICK_DEFAULT = "#d4d4d4";
export const PICK_DEFAULT_2 = "#737373";

const COLOURABLE_KINDS = new Set(["name_color", "name_glow", "smoke_color", "grenade_trail", "grenade_light", "flash_effect"]);
const FIXED_FX = new Set(["rainbow", "prism", "spectrum"]);
const HEX = /^#[0-9a-f]{6}$/i;

type ItemLike = { kind?: unknown; unlock?: unknown; fx?: unknown };

export function isColourable(item: ItemLike) {
  return COLOURABLE_KINDS.has(String(item.kind ?? "")) && String(item.unlock ?? "") === "coin" && !FIXED_FX.has(String(item.fx ?? ""));
}

/** The dual smoke takes two colours (its grenades alternate between them). */
export function isTwoColour(item: ItemLike) {
  return String(item.kind ?? "") === "smoke_color" && String(item.fx ?? "") === "dual";
}

/** Which field of the item the colour goes in: a glow's light, or everything else's colour. */
export function colourField(item: ItemLike): "color" | "glow" {
  return String(item.kind ?? "") === "name_glow" ? "glow" : "color";
}

/** The colours an item shows for one player: their pick, or the neutral default; fixed items keep their own. */
export function itemColours(item: ItemLike & { color?: unknown; color2?: unknown; glow?: unknown }, pick?: { color?: unknown; color2?: unknown } | null) {
  if (!isColourable(item)) return { color: HEX.test(String(item.color ?? "")) ? String(item.color) : null, color2: HEX.test(String(item.color2 ?? "")) ? String(item.color2) : null, glow: HEX.test(String(item.glow ?? "")) ? String(item.glow) : null };
  const first = HEX.test(String(pick?.color ?? "")) ? String(pick!.color).toLowerCase() : PICK_DEFAULT;
  const second = isTwoColour(item) ? (HEX.test(String(pick?.color2 ?? "")) ? String(pick!.color2).toLowerCase() : PICK_DEFAULT_2) : null;
  return colourField(item) === "glow" ? { color: null, color2: null, glow: first } : { color: first, color2: second, glow: null };
}
