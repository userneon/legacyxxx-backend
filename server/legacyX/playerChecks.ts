import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Player checks. A staff member (Admin, Manager or Owner) asks a player to run the checker program with a one-time code;
 * the program sends back a summary, staff read it and decide. The code is shown once and stored only as a hash.
 */
export const CHECK_ROLES = ["ADMIN", "MANAGER", "OWNER"] as const;
/** How long a code works after it is made. */
export const CHECK_CODE_MINUTES = 60;
/** Finished checks are deleted after this many days. */
export const CHECK_RETENTION_DAYS = 30;
/** How many times one check's personal download can be fetched (a second try after a failed download is fine). */
export const CHECK_MAX_DOWNLOADS = 3;

/** No 0/O, 1/I/L: a code read out loud or copied by hand is not misread. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A new one-time code like K7F2-9QX4. */
export function generateCheckCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Letters and digits only, upper case: how a typed code is compared. Returns null when it cannot be a code. */
export function normalizeCheckCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.length === 8 && Array.from(clean).every((char) => ALPHABET.includes(char)) ? clean : null;
}

export function hashCheckCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

export const createCheckSchema = z.object({ steamId: z.string().regex(/^\d{17}$/, "A Steam ID has 17 digits") }).strict();

const text = (max: number) => z.string().trim().max(max);

/** What the checker program sends back. Names and masked paths only: never file contents, screenshots or keystrokes. */
export const checkReportSchema = z
  .object({
    consent: z.literal(true),
    checkerVersion: text(20).min(1),
    steamIds: z.array(z.string().regex(/^\d{17}$/)).max(10),
    /** What Steam's own files on the PC say about each account that signed in. Optional: an older checker does not send it. */
    steamAccounts: z
      .array(
        z
          .object({
            steamId: z.string().regex(/^\d{17}$/),
            accountName: text(64).optional(),
            personaName: text(64).optional(),
            lastLogin: z.string().datetime().optional(),
            mostRecent: z.boolean().optional(),
            cs2LastPlayed: z.string().datetime().optional(),
            cs2Hours: z.number().min(0).max(100_000).optional(),
            launchOptions: text(160).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    cs2: z.object({ installed: z.boolean(), lastUpdated: z.string().datetime().optional() }).strict().optional(),
    filesScanned: z.number().int().min(0).max(100_000_000),
    durationSeconds: z.number().int().min(0).max(86_400),
    findings: z
      .array(
        z
          .object({
            name: text(120).min(1),
            kind: z.enum(["file", "process", "trace", "steam", "tamper"]),
            confidence: z.enum(["detection", "suspicion"]),
            path: text(200).optional(),
            note: text(200).optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export type CheckReport = z.infer<typeof checkReportSchema>;

/** The stored report plus whether the Steam accounts found on the PC include the player who was asked. */
export function summarizeReport(report: CheckReport, targetSteamId: string, steamBans: unknown[] = []) {
  const detections = report.findings.filter((finding) => finding.confidence === "detection").length;
  return {
    ...report,
    /** What Steam itself says about the accounts (names, VAC and game bans). Added by the server, not sent by the program. */
    steamBans,
    consent: true as const,
    detections,
    suspicions: report.findings.length - detections,
    matchesTarget: report.steamIds.includes(targetSteamId),
  };
}
