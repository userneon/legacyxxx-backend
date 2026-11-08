import { z } from "zod";

/**
 * Holidays the website, the iOS app and the Discord bot dress up for (owner request 2026-11-08: Halloween, New Year, Tsagaan Sar, "scheduled, and
 * everything changes by itself"). Staff → Settings → Events (Owner) adds an event with a start and an end day; GET /public/events/active says which one runs today,
 * and each surface draws its own look for the theme. Tsagaan Sar moves every year, so the days are always typed in, never worked out.
 */

export const EVENT_THEMES = ["halloween", "new-year", "tsagaan-sar"] as const;
export type EventTheme = (typeof EVENT_THEMES)[number];

/** Days are Ulaanbaatar days (UTC+8, no summer time), like the rest of the site. */
const UB_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function ulaanbaatarDay(now: Date = new Date()): string {
  return new Date(now.getTime() + UB_OFFSET_MS).toISOString().slice(0, 10);
}

const dayField = z.string().regex(DAY).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "Not a real date");

export const siteEventSchema = z
  .object({
    theme: z.enum(EVENT_THEMES),
    title: z.string().trim().min(1).max(60),
    startsOn: dayField,
    endsOn: dayField,
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.endsOn >= value.startsOn, { message: "The last day cannot be before the first day", path: ["endsOn"] })
  .refine((value) => (Date.parse(`${value.endsOn}T00:00:00Z`) - Date.parse(`${value.startsOn}T00:00:00Z`)) / 86_400_000 <= 62, { message: "An event runs at most 62 days", path: ["endsOn"] });

export type SiteEventInput = z.infer<typeof siteEventSchema>;

export interface SiteEventRecord {
  id: string;
  theme: string;
  title: string;
  starts_on: string;
  ends_on: string;
  enabled: boolean;
}

export function siteEventView(record: SiteEventRecord) {
  return { id: record.id, theme: record.theme, title: record.title, startsOn: record.starts_on, endsOn: record.ends_on, enabled: Boolean(record.enabled) };
}

/**
 * The event running on a day: switched on, a known theme, the day between its first and last day (both included). When two overlap, the one that
 * started later wins (the more specific one), then the title for a stable answer.
 */
export function activeSiteEvent<T extends SiteEventRecord>(records: readonly T[], day: string): T | null {
  const running = records.filter((record) => record.enabled && (EVENT_THEMES as readonly string[]).includes(record.theme) && record.starts_on <= day && day <= record.ends_on);
  running.sort((a, b) => (a.starts_on === b.starts_on ? a.title.localeCompare(b.title) : a.starts_on < b.starts_on ? 1 : -1));
  return running[0] ?? null;
}
