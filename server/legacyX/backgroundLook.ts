import { z } from "zod";

/**
 * The settings of a profile background (owner request 2026-11-02): the knobs of the React Bits background the player owns, saved per player and per
 * background. The knobs differ from one background to the next, so the API checks only the shape and the size of what is saved, and the website keeps
 * only the knobs the background really has, inside their ranges (src/lib/backgrounds.ts), whatever is stored.
 */
const knob = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/);
const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);
const value = z.union([z.number().finite().min(-100_000).max(100_000), z.boolean(), z.string().max(40), z.array(hex).min(1).max(8)]);

export const backgroundLookSchema = z.record(knob, value).refine((look) => Object.keys(look).length <= 40, "Too many settings");

export type BackgroundLook = z.infer<typeof backgroundLookSchema>;

/** A stored look read back; anything that no longer fits is dropped. */
export function readBackgroundLook(raw: unknown): BackgroundLook | null {
  const parsed = backgroundLookSchema.safeParse(raw);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : null;
}

export const isBackgroundItem = (id: string) => /^bg-[a-z0-9-]{2,36}$/.test(id);
