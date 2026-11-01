import { randomInt } from "node:crypto";

/** Letters and digits that cannot be mistaken for each other (no 0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REFERRAL_CODE_LENGTH = 6;

/** A new random creator code, e.g. "K7M2QX". */
export function newReferralCode(): string {
  let code = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** What a player typed, made comparable: upper case, no spaces or dashes; null when it cannot be a code. */
export function cleanReferralCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  return code.length === REFERRAL_CODE_LENGTH && code.split("").every((ch) => ALPHABET.includes(ch)) ? code : null;
}

export type ReferralRefusal = "own_code" | "already_used" | "too_old" | "not_played" | "creator";

/** Why this player cannot enter a creator's code right now, or null when they can. */
export function referralRefusal(input: { isCreator: boolean; alreadyUsed: boolean; accountAgeDays: number; windowDays: number; rankedMatches: number }): ReferralRefusal | null {
  if (input.isCreator) return "creator";
  if (input.alreadyUsed) return "already_used";
  if (input.accountAgeDays > input.windowDays) return "too_old";
  if (input.rankedMatches < 1) return "not_played";
  return null;
}
