import { describe, expect, it } from "vitest";
import { applyWalletChange, loadWallet, NotEnoughCoinsError, walletGrantSchema } from "./wallet";

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
