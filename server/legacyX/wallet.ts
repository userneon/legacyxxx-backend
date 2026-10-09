import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Coin wallet (supabase/legacy_x_wallet.sql). Balance changes only ever go through the database function
 * `wallet_apply`, which keeps the balance from going below zero and writes the append-only ledger.
 */

type Db = SupabaseClient<any, any, any, any, any>;

export const COIN_GRANT_MAX = 1_000_000;

export const walletGrantSchema = z.object({
  userId: z.string().uuid().optional(),
  steamId: z.string().regex(/^\d{15,20}$/, "SteamID64 expected").optional(),
  amount: z.number().int().min(1).max(COIN_GRANT_MAX),
  reason: z.string().trim().min(3).max(200),
  /** Makes a retry harmless: the same ref is applied once. */
  ref: z.string().trim().min(1).max(120).optional(),
}).strict().refine((value) => Boolean(value.userId) !== Boolean(value.steamId), "Send either userId or steamId");

/** A penalty takes coins away; same fields as a grant (who, how many, why). */
export const walletPenaltySchema = walletGrantSchema;

export class NotEnoughCoinsError extends Error {
  constructor() {
    super("Not enough coins");
  }
}

/**
 * Opens the wallet if it does not exist yet, with the welcome bonus (once, in the same step). Every way into the wallet
 * goes through here first, so a player's first touch always starts them at the welcome amount.
 */
export async function ensureWallet(db: Db, userId: string): Promise<number> {
  const { data, error } = await db.rpc("wallet_ensure", { p_user_id: userId, p_welcome: COIN_RULES.welcome });
  if (error) throw error;
  return Number(data ?? 0);
}

export interface WalletChange {
  userId: string;
  amount: number;
  kind: "grant" | "spend" | "refund" | "adjust";
  reason: string;
  ref?: string | null;
  actor?: string | null;
}

/** Applies one change; resolves to the new balance and whether it was applied (false: this ref was already used). */
export async function applyWalletChange(db: Db, change: WalletChange): Promise<{ balance: number; applied: boolean }> {
  await ensureWallet(db, change.userId);
  const { data, error } = await db.rpc("wallet_apply", {
    p_user_id: change.userId,
    p_amount: change.amount,
    p_kind: change.kind,
    p_reason: change.reason,
    p_ref: change.ref ?? null,
    p_actor: change.actor ?? null,
  });
  if (error) {
    if (/insufficient coins/i.test(String(error.message))) throw new NotEnoughCoinsError();
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { balance: Number(row?.new_balance ?? 0), applied: Boolean(row?.applied) };
}

/** Takes up to `amount` coins (never more than the player has) and says how many it really took. */
export async function penalizeWallet(
  db: Db,
  penalty: { userId: string; amount: number; reason: string; ref?: string | null; actor?: string | null },
): Promise<{ balance: number; taken: number; applied: boolean }> {
  await ensureWallet(db, penalty.userId);
  const { data, error } = await db.rpc("wallet_penalize", {
    p_user_id: penalty.userId,
    p_amount: penalty.amount,
    p_reason: penalty.reason,
    p_ref: penalty.ref ?? null,
    p_actor: penalty.actor ?? null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { balance: Number(row?.new_balance ?? 0), taken: Number(row?.taken ?? 0), applied: Boolean(row?.applied) };
}

export interface WalletView {
  balance: number;
  transactions: { id: string; amount: number; kind: string; reason: string; balanceAfter: number; at: string }[];
}

/** The player's balance and their latest ledger lines (their own only). Opening the wallet gives the welcome bonus once. */
export async function loadWallet(db: Db, userId: string, limit = 20): Promise<WalletView> {
  await ensureWallet(db, userId);
  const [wallet, ledger] = await Promise.all([
    db.from("wallets").select("balance").eq("user_id", userId).maybeSingle(),
    db.from("wallet_transactions").select("id,amount,kind,reason,balance_after,created_at").eq("user_id", userId).order("id", { ascending: false }).limit(limit),
  ]);
  if (wallet.error) throw wallet.error;
  if (ledger.error) throw ledger.error;
  return {
    balance: Number((wallet.data as { balance?: unknown } | null)?.balance ?? 0),
    transactions: ((ledger.data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      amount: Number(row.amount),
      kind: String(row.kind),
      reason: String(row.reason),
      balanceAfter: Number(row.balance_after),
      at: String(row.created_at),
    })),
  };
}

/**
 * What the coins are worth, in one place. A finished ranked match pays `match`, a win adds `win`; the EXP limits
 * apply to coins too (past the daily limit a quarter, past the weekly limit nothing), so farming does not pay.
 * Creating a clan costs `clanFee`: about 10 wins or 25 losses.
 */
export const COIN_RULES = {
  match: 20,
  win: 30,
  clanFee: 500,
  clanRename: 200,
  /** Extra member slots: `clanSlotStep` more places for `clanSlotPrice`, up to `clanSlotCap` members. */
  clanSlotPrice: 300,
  clanSlotStep: 2,
  clanSlotCap: 50,
  /** Every new wallet starts with this. */
  welcome: 50,
  /** The daily EXP limit pays this share of the coins, like it does for EXP. */
  overDailyLimitShare: 0.25,
  /** The first ranked win of each (Ulaanbaatar) day. */
  firstWinOfDay: 25,
  /** Each rank a player reaches for the first time. Falling and climbing back pays nothing again. */
  rankUp: 50,
  /** Linking a Discord account, once per player. */
  discordLink: 50,
  /** Ranked matches on 3 days in a row, then every 7th day of the run (3, 7, 10, 14 ...). */
  streakThree: 30,
  streakSeven: 100,
} as const;

/** The earning rules as the website shows them (one source: COIN_RULES). */
export function earnRules() {
  return [
    { id: "match", label: "Ranked match", coins: COIN_RULES.match },
    { id: "win", label: "Ranked win", coins: COIN_RULES.win },
    { id: "first-win", label: "First win of the day", coins: COIN_RULES.firstWinOfDay },
    { id: "rank-up", label: "Each new rank", coins: COIN_RULES.rankUp },
    { id: "streak-3", label: "3 days in a row", coins: COIN_RULES.streakThree },
    { id: "streak-7", label: "7 days in a row", coins: COIN_RULES.streakSeven },
    { id: "discord", label: "Link Discord (once)", coins: COIN_RULES.discordLink },
  ];
}

const DAY_MS = 86_400_000;
/** The player's day: Ulaanbaatar time (UTC+8), as YYYY-MM-DD. */
export function playDay(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** How many days in a row, ending on `today`, the player played (days as YYYY-MM-DD). */
export function streakLength(days: Iterable<string>, today: string): number {
  const played = new Set(days);
  let length = 0;
  for (let cursor = Date.parse(`${today}T00:00:00Z`); played.has(new Date(cursor).toISOString().slice(0, 10)); cursor -= DAY_MS) length += 1;
  return length;
}

export interface MatchBonusInput {
  outcome: "win" | "draw" | "loss";
  countsAsRankedMatch: boolean;
  limited?: "daily" | "weekly";
  rankBeforeId: number;
  rankAfterId: number;
  /** Days in a row ending today, this match included. */
  streakDays: number;
}

/** The extra coins one finished match can earn on top of the match itself. A limited (farming) player earns none. */
export function matchBonuses(player: MatchBonusInput): Array<{ key: string; amount: number; reason: string }> {
  if (!player.countsAsRankedMatch || player.limited) return [];
  const bonuses: Array<{ key: string; amount: number; reason: string }> = [];
  if (player.outcome === "win") bonuses.push({ key: "first-win", amount: COIN_RULES.firstWinOfDay, reason: "First win of the day" });
  for (let rank = player.rankBeforeId + 1; rank <= player.rankAfterId; rank += 1) bonuses.push({ key: `rank-${rank}`, amount: COIN_RULES.rankUp, reason: "New rank" });
  if (player.streakDays >= 3 && player.streakDays % 7 === 3) bonuses.push({ key: "streak-3", amount: COIN_RULES.streakThree, reason: "3 days in a row" });
  if (player.streakDays >= 7 && player.streakDays % 7 === 0) bonuses.push({ key: "streak-7", amount: COIN_RULES.streakSeven, reason: "7 days in a row" });
  return bonuses;
}

export interface MatchCoinInput {
  outcome: "win" | "draw" | "loss";
  /** A valid match the player stayed in (not a leaver, not a short or invalid match). */
  countsAsRankedMatch: boolean;
  limited?: "daily" | "weekly";
}

/** Coins one player earns from one finished ranked match. */
export function matchCoins(player: MatchCoinInput): number {
  if (!player.countsAsRankedMatch) return 0;
  if (player.limited === "weekly") return 0;
  const full = COIN_RULES.match + (player.outcome === "win" ? COIN_RULES.win : 0);
  return player.limited === "daily" ? Math.floor(full * COIN_RULES.overDailyLimitShare) : full;
}

/**
 * Pays everyone in a finished match, once: the ref is the match, so a replayed result (or a retry after a failure)
 * pays nobody twice. A wallet problem is logged and never fails the ranking that already happened. Resolves to
 * how many players were paid just now.
 */
export async function awardMatchCoins(
  db: Db,
  matchId: string,
  players: { userId: string; outcome: "win" | "draw" | "loss"; countsAsRankedMatch: boolean; breakdown: { limited?: "daily" | "weekly" } }[],
  log: (message: string, error: unknown) => void = () => undefined,
): Promise<number> {
  let paid = 0;
  for (const player of players) {
    const amount = matchCoins({ outcome: player.outcome, countsAsRankedMatch: player.countsAsRankedMatch, limited: player.breakdown.limited });
    if (amount <= 0) continue;
    try {
      const result = await applyWalletChange(db, {
        userId: player.userId,
        amount,
        kind: "grant",
        reason: player.outcome === "win" ? "Ranked match won" : "Ranked match played",
        ref: `match:${matchId}`,
      });
      if (result.applied) paid += 1;
    } catch (error) {
      // The wallet tables may not exist yet; either way the match result stands.
      log(`Unable to pay coins for match ${matchId} to ${player.userId}`, error);
    }
  }
  return paid;
}

/**
 * Pays the extras of a finished match (first win of the day, a new rank, a streak). Every payment has its own ref, so a
 * replayed result or a second win the same day pays nothing twice; a wallet problem is logged and never fails the ranking.
 */
export async function awardMatchBonuses(
  db: Db,
  matchId: string,
  finishedAt: Date,
  players: { userId: string; outcome: "win" | "draw" | "loss"; countsAsRankedMatch: boolean; breakdown: { limited?: "daily" | "weekly" }; rankBefore: { id: number }; rankAfter: { id: number } }[],
  log: (message: string, error: unknown) => void = () => undefined,
): Promise<number> {
  const counted = players.filter((player) => player.countsAsRankedMatch && !player.breakdown.limited);
  if (counted.length === 0) return 0;
  const today = playDay(finishedAt);
  const daysByUser = new Map<string, Set<string>>();
  try {
    const since = new Date(finishedAt.getTime() - 10 * DAY_MS).toISOString();
    const { data, error } = await db.from("competitive_match_exp").select("user_id,created_at").in("user_id", counted.map((player) => player.userId)).gte("created_at", since);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ user_id: string; created_at: string }>) {
      const days = daysByUser.get(row.user_id) ?? new Set<string>();
      days.add(playDay(new Date(row.created_at)));
      daysByUser.set(row.user_id, days);
    }
  } catch (error) {
    log(`Unable to read the play days for match ${matchId}`, error);
  }
  let paid = 0;
  for (const player of counted) {
    const days = daysByUser.get(player.userId) ?? new Set<string>();
    days.add(today);
    const bonuses = matchBonuses({ outcome: player.outcome, countsAsRankedMatch: true, rankBeforeId: player.rankBefore.id, rankAfterId: player.rankAfter.id, streakDays: streakLength(days, today) });
    for (const bonus of bonuses) {
      // One payment per player per day for the daily ones, once ever for a rank, once per day-of-the-run for a streak.
      const ref = bonus.key.startsWith("rank-") ? `bonus:${bonus.key}:${player.userId}` : `bonus:${bonus.key}:${player.userId}:${today}`;
      try {
        const result = await applyWalletChange(db, { userId: player.userId, amount: bonus.amount, kind: "grant", reason: bonus.reason, ref });
        if (result.applied) paid += 1;
      } catch (error) {
        log(`Unable to pay the ${bonus.key} bonus of match ${matchId} to ${player.userId}`, error);
      }
    }
  }
  return paid;
}

/** The one-time coins for linking Discord. */
export async function awardDiscordLink(db: Db, userId: string, log: (message: string, error: unknown) => void = () => undefined): Promise<boolean> {
  try {
    return (await applyWalletChange(db, { userId, amount: COIN_RULES.discordLink, kind: "grant", reason: "Discord linked", ref: `bonus:discord-link:${userId}` })).applied;
  } catch (error) {
    log(`Unable to pay the Discord link bonus to ${userId}`, error);
    return false;
  }
}

/** What the clan services cost, for the Shop (one source: COIN_RULES). */
export function clanPrices() {
  return { create: COIN_RULES.clanFee, rename: COIN_RULES.clanRename, slots: COIN_RULES.clanSlotPrice, slotStep: COIN_RULES.clanSlotStep, slotCap: COIN_RULES.clanSlotCap };
}
