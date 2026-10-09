import { buildWalletSummary, describe, expect, it } from "vitest";
import { COIN_RULES, buildWalletSummary, applyWalletChange, awardDiscordLink, awardMatchBonuses, awardMatchCoins, earnRules, matchBonuses, playDay, streakLength, ensureWallet, loadWallet, matchCoins, penalizeWallet, walletPenaltySchema, NotEnoughCoinsError, walletGrantSchema } from "./wallet";

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
    const db = { rpc: async (name: string, args: unknown) => (calls.push([name, args]), name === "wallet_ensure" ? { data: 50, error: null } : { data: [{ new_balance: 60, applied: true }], error: null }) } as any;
    expect(await applyWalletChange(db, { userId: USER, amount: 10, kind: "grant", reason: "Prize", ref: "prize-1", actor: null })).toEqual({ balance: 60, applied: true });
    // The wallet is opened first (with the welcome bonus, once), then the change is applied.
    expect(calls).toEqual([
      ["wallet_ensure", { p_user_id: USER, p_welcome: COIN_RULES.welcome }],
      ["wallet_apply", { p_user_id: USER, p_amount: 10, p_kind: "grant", p_reason: "Prize", p_ref: "prize-1", p_actor: null }],
    ]);
  });

  it("says so when the player cannot afford it, and passes other failures on", async () => {
    const broke = { rpc: async (name: string) => (name === "wallet_ensure" ? { data: 0, error: null } : { data: null, error: { message: "insufficient coins" } }) } as any;
    await expect(applyWalletChange(broke, { userId: USER, amount: -10, kind: "spend", reason: "Clan" })).rejects.toBeInstanceOf(NotEnoughCoinsError);
    const down = { rpc: async (name: string) => (name === "wallet_ensure" ? { data: 0, error: null } : { data: null, error: { message: "connection reset" } }) } as any;
    await expect(applyWalletChange(down, { userId: USER, amount: -10, kind: "spend", reason: "Clan" })).rejects.toMatchObject({ message: "connection reset" });
  });

  it("reads a balance, 0 when the player has no wallet yet", async () => {
    const table = (data: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }), order: () => ({ limit: async () => ({ data: [{ id: 7, amount: -10, kind: "spend", reason: "Clan", balance_after: 40, created_at: "2026-10-06T00:00:00Z" }], error: null }) }) }) }) });
    const db = { rpc: async () => ({ data: 0, error: null }), from: (name: string) => (name === "wallets" ? table(null) : table(null)) } as any;
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
    const db = { rpc: async (name: string, args: Record<string, unknown>) => (name === "wallet_ensure" ? { data: 50, error: null } : (calls.push(args), { data: [{ new_balance: 1, applied: args.p_user_id !== "u3" }], error: null })) } as any;
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

describe("welcome bonus and penalty", () => {
  it("every new wallet starts with 50", async () => {
    expect(COIN_RULES.welcome).toBe(50);
    const calls: unknown[] = [];
    const db = { rpc: async (name: string, args: unknown) => (calls.push([name, args]), { data: 50, error: null }) } as any;
    expect(await ensureWallet(db, USER)).toBe(50);
    expect(calls).toEqual([["wallet_ensure", { p_user_id: USER, p_welcome: 50 }]]);
  });

  it("a penalty reports what it really took, which can be less than asked", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const db = { rpc: async (name: string, args: Record<string, unknown>) => (calls.push([name, args]), name === "wallet_ensure" ? { data: 20, error: null } : { data: [{ new_balance: 0, taken: 20, applied: true }], error: null }) } as any;
    expect(await penalizeWallet(db, { userId: USER, amount: 100, reason: "Cheating", ref: "case-7", actor: "owner-1" })).toEqual({ balance: 0, taken: 20, applied: true });
    expect(calls.map(([name]) => name)).toEqual(["wallet_ensure", "wallet_penalize"]);
    expect(calls[1]![1]).toEqual({ p_user_id: USER, p_amount: 100, p_reason: "Cheating", p_ref: "case-7", p_actor: "owner-1" });
  });

  it("a penalty has the same input rules as a grant", () => {
    expect(walletPenaltySchema.safeParse({ steamId: "76561198000000000", amount: 30, reason: "Cheating" }).success).toBe(true);
    expect(walletPenaltySchema.safeParse({ userId: USER, amount: -30, reason: "Cheating" }).success).toBe(false);
    expect(walletPenaltySchema.safeParse({ userId: USER, amount: 30, reason: "no" }).success).toBe(false);
  });
});

describe("coin bonuses", () => {
  const base = { outcome: "win" as const, countsAsRankedMatch: true, rankBeforeId: 4, rankAfterId: 4, streakDays: 1 };

  it("days are Ulaanbaatar days and a streak counts days in a row ending today", () => {
    expect(playDay(new Date("2026-10-08T15:59:00Z"))).toBe("2026-10-08");
    expect(playDay(new Date("2026-10-08T16:01:00Z"))).toBe("2026-10-09");
    expect(streakLength(["2026-10-08", "2026-10-07", "2026-10-06", "2026-10-04"], "2026-10-08")).toBe(3);
    expect(streakLength(["2026-10-07"], "2026-10-08")).toBe(0);
    expect(streakLength(["2026-10-08"], "2026-10-08")).toBe(1);
  });

  it("pays the first win of the day, each new rank, and the 3 and 7 day streaks", () => {
    expect(matchBonuses(base)).toEqual([{ key: "first-win", amount: COIN_RULES.firstWinOfDay, reason: "First win of the day" }]);
    expect(matchBonuses({ ...base, outcome: "loss" })).toEqual([]);
    expect(matchBonuses({ ...base, outcome: "loss", rankBeforeId: 4, rankAfterId: 6 }).map((bonus) => bonus.key)).toEqual(["rank-5", "rank-6"]);
    expect(matchBonuses({ ...base, outcome: "loss", streakDays: 3 }).map((bonus) => bonus.key)).toEqual(["streak-3"]);
    expect(matchBonuses({ ...base, outcome: "loss", streakDays: 7 }).map((bonus) => bonus.key)).toEqual(["streak-7"]);
    expect(matchBonuses({ ...base, outcome: "loss", streakDays: 10 }).map((bonus) => bonus.key)).toEqual(["streak-3"]);
    expect(matchBonuses({ ...base, outcome: "loss", streakDays: 5 })).toEqual([]);
  });

  it("pays nothing to a player who is over the EXP limit or did not count", () => {
    expect(matchBonuses({ ...base, limited: "daily", rankAfterId: 6 })).toEqual([]);
    expect(matchBonuses({ ...base, limited: "weekly" })).toEqual([]);
    expect(matchBonuses({ ...base, countsAsRankedMatch: false })).toEqual([]);
  });

  it("pays each bonus once: a second win the same day or a replayed match pays nothing", async () => {
    const seen = new Set<string>();
    const paid: Array<{ amount: number; ref: string }> = [];
    const db = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "wallet_ensure") return { data: 50, error: null };
        const ref = String(args.p_ref);
        const fresh = !seen.has(ref);
        seen.add(ref);
        if (fresh) paid.push({ amount: Number(args.p_amount), ref });
        return { data: [{ new_balance: 100, applied: fresh }], error: null };
      },
      from: () => ({ select: () => ({ in: () => ({ gte: async () => ({ data: [{ user_id: USER, created_at: "2026-10-06T10:00:00Z" }, { user_id: USER, created_at: "2026-10-07T10:00:00Z" }], error: null }) }) }) }),
    } as any;
    const win = [{ userId: USER, outcome: "win" as const, countsAsRankedMatch: true, breakdown: {}, rankBefore: { id: 4 }, rankAfter: { id: 5 } }];
    const at = new Date("2026-10-08T10:00:00Z");
    expect(await awardMatchBonuses(db, "m1", at, win)).toBe(3);
    expect(paid.map((entry) => entry.amount).sort((a, b) => a - b)).toEqual([COIN_RULES.streakThree, COIN_RULES.firstWinOfDay, COIN_RULES.rankUp].sort((a, b) => a - b));
    expect(await awardMatchBonuses(db, "m1", at, win)).toBe(0);
    // A second win the same day with no new rank: nothing new.
    expect(await awardMatchBonuses(db, "m2", at, [{ ...win[0]!, rankBefore: { id: 5 }, rankAfter: { id: 5 } }])).toBe(0);
  });

  it("pays the Discord link once, and lists the rules from the same numbers", async () => {
    const seen = new Set<string>();
    const db = { rpc: async (name: string, args: Record<string, unknown>) => (name === "wallet_ensure" ? { data: 50, error: null } : { data: [{ new_balance: 100, applied: !seen.has(String(args.p_ref)) && !!seen.add(String(args.p_ref)) }], error: null }) } as any;
    expect(await awardDiscordLink(db, USER)).toBe(true);
    expect(await awardDiscordLink(db, USER)).toBe(false);
    expect(earnRules().find((rule) => rule.id === "discord")?.coins).toBe(COIN_RULES.discordLink);
  });
});

describe("wallet summary", () => {
  // 2026-10-10 12:00 UTC is 20:00 on 2026-10-10 in Ulaanbaatar.
  const now = new Date("2026-10-10T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

  it("adds up what was earned today and this week, and what was spent in total", () => {
    const summary = buildWalletSummary(
      [
        { amount: 50, kind: "grant", at: hoursAgo(1) },
        { amount: 25, kind: "grant", at: hoursAgo(2) },
        { amount: 30, kind: "grant", at: hoursAgo(30) },
        { amount: -450, kind: "spend", at: hoursAgo(30) },
        { amount: 450, kind: "refund", at: hoursAgo(29) },
        { amount: -300, kind: "spend", at: hoursAgo(24 * 20) },
      ],
      [hoursAgo(1), hoursAgo(2), hoursAgo(30)],
      now,
    );
    expect(summary.todayEarned).toBe(75);
    expect(summary.weekEarned).toBe(105);
    expect(summary.todayMatches).toBe(2);
    expect(summary.weekMatches).toBe(3);
    // A refund is not income, and old spending still counts toward the total.
    expect(summary.spentTotal).toBe(750);
    expect(summary.spentCount).toBe(2);
    expect(summary.daily).toHaveLength(14);
    expect(summary.daily[13]).toEqual({ day: "2026-10-10", earned: 75 });
    expect(summary.daily[12].earned).toBe(30);
  });

  it("counts the days in a row and marks the week", () => {
    const summary = buildWalletSummary([], [hoursAgo(1), hoursAgo(25), hoursAgo(49), hoursAgo(97)], now);
    expect(summary.streakDays).toBe(3);
    expect(summary.week).toHaveLength(7);
    // Oldest first: 6 days ago and 5 days ago were free, 4 days ago was played, then a gap, then 3 days in a row up to today.
    expect(summary.week.map((entry) => entry.played)).toEqual([false, false, true, false, true, true, true]);
  });

  it("is all zeros for a player with no history", () => {
    const summary = buildWalletSummary([], [], now);
    expect(summary).toMatchObject({ todayEarned: 0, weekEarned: 0, spentTotal: 0, streakDays: 0 });
  });
});
