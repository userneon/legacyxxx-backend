/**
 * Rules of an LX top-up that do not depend on the payment gateway (the gateway itself is wire.ts).
 */

/** An unpaid top-up is shown as expired after this long (Wire cancels its own payment after 10 minutes). */
export const TOPUP_MINUTES = 12;

/** A top-up of any amount (owner request 2026-11-02): paid at the smallest package's rate, so a bigger package is always the better deal. */
export const CUSTOM_TOPUP_MIN_MNT = 1000;
export const CUSTOM_TOPUP_MAX_MNT = 500_000;
export const CUSTOM_TOPUP_STEP_MNT = 1000;
export function customTopUpLx(amountMnt: number, base: { priceMnt: number; grantsLx: number }) {
  if (!Number.isInteger(amountMnt) || amountMnt < CUSTOM_TOPUP_MIN_MNT || amountMnt > CUSTOM_TOPUP_MAX_MNT || amountMnt % CUSTOM_TOPUP_STEP_MNT !== 0) return null;
  if (base.priceMnt <= 0 || base.grantsLx <= 0) return null;
  const lx = Math.floor((amountMnt * base.grantsLx) / base.priceMnt);
  return lx > 0 ? lx : null;
}
