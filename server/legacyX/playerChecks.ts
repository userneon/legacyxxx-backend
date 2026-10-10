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

/** An account that signed in to Steam this recently before a scan (or since the scan began) is one the player was just using. */
export const RECENT_LOGIN_MINUTES = 30;

/**
 * Which of the Steam accounts found on a PC were signed in within the last few minutes before `at`. Accounts used days ago (a sibling, an old
 * account) are left out; an account the player switched to just before the scan is in. An account with no known sign-in time is left out.
 */
export function recentSteamIds(accounts: Array<{ steamId: string; lastLogin?: string | null }> | undefined, at: Date, minutes = RECENT_LOGIN_MINUTES): string[] {
  const ids: string[] = [];
  for (const account of accounts ?? []) {
    const signedIn = account.lastLogin ? Date.parse(account.lastLogin) : NaN;
    if (!Number.isFinite(signedIn)) continue;
    const ago = at.getTime() - signedIn;
    // A few minutes of clock difference between the PC and the server are allowed.
    if (ago >= -5 * 60_000 && ago <= minutes * 60_000) ids.push(account.steamId);
  }
  return Array.from(new Set(ids));
}

export const HWID_KINDS = ["id", "uuid", "board", "bios", "cpu", "disk", "machine"] as const;
/** The parts that say "same PC" (a Windows reinstall changes "machine" only, so it is kept but never used to match). */
export const HWID_MATCH_KINDS = ["id", "uuid", "board", "bios", "cpu", "disk"] as const;

/**
 * Whether the hardware parts two accounts have in common are enough to say "the same PC": the whole-PC value, or at least two different strong parts
 * (system id, motherboard, BIOS, a disk). A processor alone is not enough: the same model can report the same id.
 */
export function sharesSamePc(kinds: Iterable<string>): boolean {
  const set = new Set(kinds);
  if (set.has("id")) return true;
  return ["uuid", "board", "bios", "disk"].filter((kind) => set.has(kind)).length >= 2;
}

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
    /**
     * A fingerprint of the PC: the program hashes each hardware serial number on the PC and sends the hashes (never the numbers). "id" is all of the
     * stable parts together; the others are single parts, so a PC that changed one disk still matches on the board and the CPU. Optional.
     */
    hwid: z
      .object({
        version: z.literal(1),
        parts: z.array(z.object({ kind: z.enum(HWID_KINDS), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1).max(12),
      })
      .strict()
      .optional(),
    /**
     * Facts about programs, not verdicts: which of the listed functions and words a program holds. The server judges them (checkerJudge.ts), so the
     * rule that decides never has to be inside the program. Not stored; only the findings made from them are.
     */
    facts: z
      .array(
        z
          .object({
            name: text(120).min(1),
            path: text(200).optional(),
            size: z.number().int().min(0).max(2_000_000_000),
            signed: z.boolean(),
            managed: z.boolean(),
            running: z.boolean().optional(),
            protector: text(24).optional(),
            apis: z.array(text(48)).max(60),
            game: z.array(text(40)).max(10),
            offsets: z.array(text(40)).max(20),
            family: z.array(text(80)).max(60),
          })
          .strict(),
      )
      .max(500)
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
