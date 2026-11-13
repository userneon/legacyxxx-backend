import { z } from "zod";

/**
 * Player reports from the website (owner request 2026-11-13, supabase/legacy_x_player_reports.sql). The rules live here so they can be tested:
 * what a report may say, how many a player may send in a day, and how staff answer.
 */
export const REPORT_CATEGORIES = ["cheating", "griefing", "toxic", "boosting", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_CATEGORY_LABEL: Record<ReportCategory, string> = { cheating: "Cheating", griefing: "Griefing", toxic: "Toxic chat or voice", boosting: "Boosting", other: "Something else" };

/** New reports one player may send in 24 hours (a flood of reports is itself abuse). */
export const REPORTS_PER_DAY = 5;

const evidence = z.string().trim().max(300).optional().transform((value) => {
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value.replace(/^http:\/\//i, "https://") : `https://${value}`;
}).refine((value) => {
  if (value === undefined) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}, { message: "The evidence must be a link (for example a clip or screenshot)" });

export const createReportSchema = z.object({
  reportedUserId: z.string().uuid(),
  category: z.enum(REPORT_CATEGORIES),
  reason: z.string().trim().min(5, "Say in a few words what happened").max(300),
  evidenceUrl: evidence,
}).strict();

export const resolveReportSchema = z.object({
  outcome: z.enum(["actioned", "dismissed"]),
  note: z.string().trim().max(200).optional(),
}).strict();

/** What the reporter reads in the bell once staff have looked. The player they reported is never named. */
export function reportOutcomeMessage(outcome: "actioned" | "dismissed"): { title: string; body: string } {
  return outcome === "actioned"
    ? { title: "Your report was acted on", body: "Staff looked at your report and took action. Thank you for helping keep LEGACY-X fair." }
    : { title: "Your report was reviewed", body: "Staff looked at your report and found nothing to act on this time. Thank you for sending it." };
}
