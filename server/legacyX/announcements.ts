import { z } from "zod";

/**
 * Update announcements: the deploy scripts post what an update changed, the Discord bot polls them and posts
 * them in the channel chosen with /updates. Text only; the bot draws a banner when `banner` names one.
 */

export const ANNOUNCEMENT_MAX_AGE_HOURS = 24;
export const ANNOUNCEMENT_PAGE = 20;
export const ANNOUNCEMENT_BANNERS = ["cs2-update-finished"] as const;

export const announcementSchema = z.object({
  title: z.string().trim().min(1).max(80),
  lines: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  footer: z.string().trim().max(200).optional(),
  banner: z.enum(ANNOUNCEMENT_BANNERS).optional(),
});

export type AnnouncementInput = z.infer<typeof announcementSchema>;

export function announcementRow(input: AnnouncementInput) {
  return { title: input.title, lines: input.lines, footer: input.footer || null, banner: input.banner ?? null };
}

export interface AnnouncementRecord {
  id: number;
  title: string;
  lines: unknown;
  footer: string | null;
  banner: string | null;
  created_at: string;
}

/** The shape the bot reads. */
export function announcementView(record: AnnouncementRecord) {
  return {
    id: Number(record.id),
    title: record.title,
    lines: Array.isArray(record.lines) ? record.lines.filter((line): line is string => typeof line === "string") : [],
    footer: record.footer,
    banner: record.banner,
    createdAt: record.created_at,
  };
}
