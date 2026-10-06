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

export class NotEnoughCoinsError extends Error {
  constructor() {
    super("Not enough coins");
  }
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

export interface WalletView {
  balance: number;
  transactions: { id: string; amount: number; kind: string; reason: string; balanceAfter: number; at: string }[];
}

/** The player's balance and their latest ledger lines (their own only). A player with no wallet row has 0. */
export async function loadWallet(db: Db, userId: string, limit = 20): Promise<WalletView> {
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
  /** The daily EXP limit pays this share of the coins, like it does for EXP. */
  overDailyLimitShare: 0.25,
} as const;

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
