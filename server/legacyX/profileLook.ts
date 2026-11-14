/** Profile customize (owner request 2026-11-14): how a player styles their name, and what a profile banner picture may be. */
import { z } from "zod";

/** The Shop product that unlocks the look; it is rented like every other cosmetic. */
export const PROFILE_CUSTOMIZE_ITEM = "profile-customize";

export const NAME_MODES = ["normal", "gradient", "glow"] as const;
export type NameMode = (typeof NAME_MODES)[number];
/** default: the site's own font; display: a technical display face; mono: a monospace face. */
export const NAME_FONTS = ["default", "display", "mono"] as const;
export type NameFont = (typeof NAME_FONTS)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const profileLookSchema = z.object({
  mode: z.enum(NAME_MODES),
  font: z.enum(NAME_FONTS).default("default"),
  color: hex.nullish(),
  color2: hex.nullish(),
  glow: hex.nullish(),
}).strict();

export interface ProfileLook {
  mode: NameMode;
  font: NameFont;
  color: string | null;
  color2: string | null;
  glow: string | null;
}

/** Keeps only what the chosen mode uses, lower-cased, and says what is missing: Gradient needs two colours, Glow needs its colour. */
export function cleanProfileLook(input: z.infer<typeof profileLookSchema>): { ok: true; look: ProfileLook } | { ok: false; message: string } {
  const low = (value?: string | null) => (value ? value.toLowerCase() : null);
  const base = { mode: input.mode, font: input.font, color: null, color2: null, glow: null } as ProfileLook;
  if (input.mode === "normal") return { ok: true, look: { ...base, color: low(input.color) } };
  if (input.mode === "gradient") {
    if (!input.color || !input.color2) return { ok: false, message: "A gradient needs two colours" };
    return { ok: true, look: { ...base, color: low(input.color), color2: low(input.color2) } };
  }
  if (!input.glow) return { ok: false, message: "A glow needs its colour" };
  return { ok: true, look: { ...base, color: low(input.color), glow: low(input.glow) } };
}

/** What a stored row looks like to the website (the `nameStyle` every player card carries); null when nothing is set. */
export function nameStyleOf(look: ProfileLook | null) {
  if (!look) return null;
  if (look.mode === "normal" && !look.color && look.font === "default") return null;
  return {
    mode: look.mode,
    font: look.font,
    color: look.color,
    color2: look.mode === "gradient" ? look.color2 : null,
    glow: look.mode === "glow" ? look.glow : null,
    colorFx: look.mode === "gradient" ? "gradient2" : null,
    glowFx: null,
  };
}

export function readProfileLook(row: Record<string, unknown> | null | undefined): ProfileLook | null {
  if (!row) return null;
  const mode = NAME_MODES.find((entry) => entry === row.name_mode);
  const font = NAME_FONTS.find((entry) => entry === row.name_font);
  if (!mode || !font) return null;
  const colour = (value: unknown) => (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null);
  return { mode, font, color: colour(row.name_color), color2: colour(row.name_color2), glow: colour(row.name_glow) };
}

/** The banner picture: a PNG, JPEG, GIF or WebP up to 5 MB (the same type check as clan pictures runs first). */
export const PROFILE_BANNER_LIMITS = { maxBytes: 5 * 1024 * 1024 } as const;
