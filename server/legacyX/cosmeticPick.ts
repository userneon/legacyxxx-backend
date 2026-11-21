/**
 * Picking your own colour (owner request 2026-11-14): after buying a colour design the player picks the colour with a colour picker and, for the smoke, one of
 * our own shapes (no uploads). Buy once, then change the colour as often as you like (owner 2026-11-21): CUSTOM_CHANGE_PRICE is 0, set it above 0 to charge for a change again. Colours are kept vivid.
 */
export const CUSTOM_CHANGE_PRICE = 0;

/** The pictures a smoke can shed (the Workshop addon's particles); null is the plain glowing dot. */
export const SMOKE_MOTIFS = ["star", "heart", "diamond", "bolt", "sparkle"] as const;
export type SmokeMotif = (typeof SMOKE_MOTIFS)[number];
export const isSmokeMotif = (value: unknown): value is SmokeMotif => (SMOKE_MOTIFS as readonly string[]).includes(String(value));

const MIN_SATURATION = 0.6;
const MIN_BRIGHTNESS = 0.85;

/** Pulls a colour up to a vivid one: the same hue, at least 60% saturation and 85% brightness (so a pale or dark pick never shows faded). */
export function vividColour(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const n = parseInt(match[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = Math.max(max === 0 ? 0 : d / max, MIN_SATURATION);
  const v = Math.max(max, MIN_BRIGHTNESS);
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const part = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${part(rr)}${part(gg)}${part(bb)}`;
}

type Pick = { color: string | null; color2: string | null; fx: string | null };

/** Whether saving `next` over `previous` is a change that costs money: there was a pick already and something in it differs. */
export function pickCosts(previous: Pick | null, next: Pick): boolean {
  if (CUSTOM_CHANGE_PRICE <= 0 || !previous) return false;
  return previous.color !== next.color || previous.color2 !== next.color2 || previous.fx !== next.fx;
}
