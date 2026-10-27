import { z } from "zod";

/**
 * What a player shows on the profile's Configs tab (owner request 2026-10-27): crosshair, mouse, keyboard, monitor, viewmodel and a few
 * free lines. Typed by the player, never read from the game. Every field is optional and bounded; an empty value is left out, so an
 * empty object clears the tab.
 */
const text = (max: number) => z.string().trim().max(max).transform((value) => value || undefined).optional();
const whole = (min: number, max: number) => z.number().int().min(min).max(max).nullish().transform((value) => value ?? undefined);
const decimal = (min: number, max: number) => z.number().min(min).max(max).nullish().transform((value) => (value === null || value === undefined ? undefined : Math.round(value * 1000) / 1000));

/** CS2's own share code: CSGO- and five groups of five letters or digits. */
export const CROSSHAIR_CODE = /^CSGO(-[A-Za-z0-9]{5}){5}$/;

export const playerConfigSchema = z.object({
  crosshair: z.string().trim().max(40).refine((value) => value === "" || CROSSHAIR_CODE.test(value), "Paste the crosshair share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx)").transform((value) => value || undefined).optional(),
  mouse: z.object({ model: text(60), dpi: whole(100, 32000), sensitivity: decimal(0.01, 20), zoomSensitivity: decimal(0.01, 5), pollingRate: whole(125, 8000) }).strict().optional(),
  keyboard: z.object({ model: text(60) }).strict().optional(),
  monitor: z.object({ resolution: text(20), refreshRate: whole(24, 600), aspect: text(10) }).strict().optional(),
  viewmodel: z.object({ fov: decimal(54, 68), offsetX: decimal(-2.5, 2.5), offsetY: decimal(-2, 2), offsetZ: decimal(-2, 2) }).strict().optional(),
  other: z.array(z.object({ label: z.string().trim().min(1).max(30), value: z.string().trim().min(1).max(100) }).strict()).max(10).optional(),
}).strict();

export type PlayerConfig = z.infer<typeof playerConfigSchema>;

/** The stored object without empty groups, or null when nothing is left. */
export function cleanPlayerConfig(input: unknown): PlayerConfig | null {
  const parsed = playerConfigSchema.safeParse(input);
  if (!parsed.success) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) { if (value.length) out[key] = value; continue; }
    if (value && typeof value === "object") {
      const kept = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
      if (Object.keys(kept).length) out[key] = kept;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length ? (out as PlayerConfig) : null;
}
