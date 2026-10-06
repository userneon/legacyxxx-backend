import { describe, expect, it } from "vitest";
import { COIN_RULES, applyWalletChange, awardMatchCoins, loadWallet, matchCoins, NotEnoughCoinsError, walletGrantSchema } from "./wallet";

const USER = "5b8a2f0c-3b1e-4c2f-9d44-0a1b2c3d4e5f";

describe("wallet grant input", () => {
  it("needs exactly one of userId and steamId, a positive whole amount and a reason", () => {
    expect(walletGrantSchema.safeParse({ userId: USER, amount: 50, reason: "Tournament prize" }).success).toBe(true);
    expect(walletGrantSchema.safeParse({ steamId: "76561198000000000", amount: 50, reason: "Tournament prize" }).success).toBe(true);
    expect(walletGrantSchema.safeParse({ amount: 50, reason: "Tournament prize" }).success).toBe(false);
    expect(walletGrantSchema.safeParse({ userId: USER, steamId: "76561198000000000", amount: 50, reason: "Tournament prize" }).success).toBe(false);
    for (const amount of [0, -5, 1.5, 2_000_000]) expect(walletGrantSchema.safeParse({ userId: USER, amount, reason: "Tournament prize" }).success).toBe(false);
    expect(walletGrantSchema.safeParse({ userId: USER, amount: 5, reason: "x" }).success).toBe(false);
    expect(walletGrantSchema.safeParse({ userId: USER, amount: 5, reason: "Tournament prize", extra: 1 }).success).toBe(false);
  });
});

describe("wallet changes", () => {
  it("sends the change to wallet_apply and returns the balance", async () => {
    const calls: unknown[] = [];
    const db = { rpc: async (name: string, args: unknown) => (calls.push([name, args]), { data: [{ new_balance: 60, applied: true }], error: null }) } as any;
    expect(await applyWalletChange(db, { userId: USER, amount: 10, kind: "grant", reason: "Prize", ref: "prize-1", actor: null })).toEqual({ balance: 60, applied: true });
    expect(calls).toEqual([["wallet_apply", { p_user_id: USER, p_amount: 10, p_kind: "grant", p_reason: "Prize", p_ref: "prize-1", p_actor: null }]]);
  });

  it("says so when the player cannot afford it, and passes other failures on", async () => {
    const broke = { rpc: async () => ({ data: null, error: { message: "insufficient coins" } }) } as any;
    await expect(applyWalletChange(broke, { userId: USER, amount: -10, kind: "spend", reason: "Clan" })).rejects.toBeInstanceOf(NotEnoughCoinsError);
    const down = { rpc: async () => ({ data: null, error: { message: "connection reset" } }) } as any;
    await expect(applyWalletChange(down, { userId: USER, amount: -10, kind: "spend", reason: "Clan" })).rejects.toMatchObject({ message: "connection reset" });
  });

  it("reads a balance, 0 when the player has no wallet yet", async () => {
    const table = (data: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }), order: () => ({ limit: async () => ({ data: [{ id: 7, amount: -10, kind: "spend", reason: "Clan", balance_after: 40, created_at: "2026-10-06T00:00:00Z" }], error: null }) }) }) }) });
    const db = { from: (name: string) => (name === "wallets" ? table(null) : table(null)) } as any;
    expect(await loadWallet(db, USER)).toEqual({ balance: 0, transactions: [{ id: "7", amount: -10, kind: "spend", reason: "Clan", balanceAfter: 40, at: "2026-10-06T00:00:00Z" }] });
  });
});

describe("match coins", () => {
  it("pays a played match, more for a win, and follows the EXP limits", () => {
    expect(matchCoins({ outcome: "loss", countsAsRankedMatch: true })).toBe(COIN_RULES.match);
    expect(matchCoins({ outcome: "draw", countsAsRankedMatch: true })).toBe(COIN_RULES.match);
    expect(matchCoins({ outcome: "win", countsAsRankedMatch: true })).toBe(COIN_RULES.match + COIN_RULES.win);
    expect(matchCoins({ outcome: "win", countsAsRankedMatch: true, limited: "daily" })).toBe(Math.floor((COIN_RULES.match + COIN_RULES.win) / 4));
    expect(matchCoins({ outcome: "win", countsAsRankedMatch: true, limited: "weekly" })).toBe(0);
    expect(matchCoins({ outcome: "win", countsAsRankedMatch: false })).toBe(0);
  });

  it("a clan costs roughly 10 wins or 25 played matches", () => {
    expect(COIN_RULES.clanFee / (COIN_RULES.match + COIN_RULES.win)).toBe(10);
    expect(COIN_RULES.clanFee / COIN_RULES.match).toBe(25);
  });

  it("pays each player once per match, skips leavers, and a failing wallet never throws", async () => {
    const calls: Record<string, unknown>[] = [];
    const db = { rpc: async (_name: string, args: Record<string, unknown>) => (calls.push(args), { data: [{ new_balance: 1, applied: args.p_user_id !== "u3" }], error: null }) } as any;
    const players = [
      { userId: "u1", outcome: "win" as const, countsAsRankedMatch: true, breakdown: {} },
      { userId: "u2", outcome: "loss" as const, countsAsRankedMatch: false, breakdown: { rule: "leaver" } },
      { userId: "u3", outcome: "loss" as const, countsAsRankedMatch: true, breakdown: { limited: "daily" as const } },
    ];
    expect(await awardMatchCoins(db, "m1", players)).toBe(1);
    expect(calls.map((c) => [c.p_user_id, c.p_amount, c.p_ref])).toEqual([["u1", 50, "match:m1"], ["u3", 5, "match:m1"]]);

    const logged: string[] = [];
    const broken = { rpc: async () => ({ data: null, error: { message: "relation does not exist" } }) } as any;
    expect(await awardMatchCoins(broken, "m2", players, (message) => logged.push(message))).toBe(0);
    expect(logged).toHaveLength(2);
  });
});
