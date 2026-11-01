import { z } from "zod";

/**
 * The Crystal Orb avatar frame (owner request 2026-11-01): a glass ball with a crackling rim and glowing dust, drawn around a round avatar
 * (the React Bits Crystalized Ball). A player who owns it sets every knob of it; this is what the API accepts and stores.
 * Every field is optional: what is missing falls back to the preset's own value on the website.
 */
export const FRAME_LOOK_PRESETS = ["plasma", "aurora", "nebula", "ember", "frost", "solar", "eclipse", "abyss"] as const;
export const FRAME_LOOK_MOTIONS = ["rise", "fall", "drift", "orbit"] as const;
export const FRAME_LOOK_SHAPES = ["square", "round"] as const;

const unit = z.number().min(0).max(1);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((value) => value.toLowerCase());

export const frameLookSchema = z.object({
  preset: z.enum(FRAME_LOOK_PRESETS),
  color: hex,
  motion: z.enum(FRAME_LOOK_MOTIONS),
  particleShape: z.enum(FRAME_LOOK_SHAPES),
  glow: unit,
  haze: unit,
  strands: z.number().int().min(1).max(12),
  crackle: unit,
  flares: unit,
  sparks: unit,
  particleCount: z.number().int().min(2000).max(30000),
  fill: unit,
  depth: unit,
  twinkle: unit,
  sway: unit,
  speed: z.number().min(0).max(3),
  dustSpeed: z.number().min(0).max(3),
  interactive: z.boolean(),
  hoverStrength: unit,
  intro: z.boolean(),
}).partial().strict();

export type FrameLook = z.infer<typeof frameLookSchema>;

/** A stored look read back from the database: anything that no longer fits the rules is dropped, so a bad row can never reach the page. */
export function readFrameLook(value: unknown): FrameLook | null {
  const parsed = frameLookSchema.safeParse(value);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : null;
}
