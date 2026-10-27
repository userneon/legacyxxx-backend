/**
 * Collectible cards (owner request 2026-10-27): bought with LX, kept, sold back. Supply is unlimited; the price follows how many copies
 * players hold right now, so the more are held the dearer the next one is. One formula, the same as `legacy_x.card_price` in
 * supabase/legacy_x_cards.sql. Nothing is random and nothing is typed in by hand.
 */
export const CARD_RARITIES = ["standard", "select", "elite", "prime", "apex"] as const;
export type CardRarity = (typeof CARD_RARITIES)[number];

/** Copies held that double the price (price = base x (1 + held / CARD_SLOPE)^2). */
export const CARD_SLOPE = 25;
/** What a sale pays of the price of the copy it takes back; the rest leaves the economy. */
export const CARD_SELL_SHARE = 0.9;

/** The price of the next copy when `held` are held. */
export function cardPrice(base: number, held: number): number {
  return Math.ceil(base * (1 + held / CARD_SLOPE) ** 2 - 1e-9);
}

/** What selling one copy pays now (zero when none is held). */
export function cardSellPrice(base: number, held: number): number {
  if (held < 1) return 0;
  return Math.max(1, Math.floor(CARD_SELL_SHARE * cardPrice(base, held - 1) + 1e-9));
}
