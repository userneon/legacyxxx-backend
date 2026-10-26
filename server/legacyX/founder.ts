import type { SupabaseClient } from "@supabase/supabase-js";
import { legacyXError } from "./supabase";

/**
 * The Genesis pack (owner decision 2026-10-23; it was called Founder until the same day, and the internal ids still are: Founder is also a staff role): one numbered, limited set, bought through a Shop order (30,000 MNT, taken by staff) and
 * given when the order is marked paid. See supabase/legacy_x_founder.sql. Nothing here sells for LX.
 */
type Db = SupabaseClient<any, any, any, any, any>;
type Row = Record<string, unknown>;

function apiError(statusCode: number, message: string, code?: string): never {
  throw Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

export const FOUNDER_PRODUCT_KIND = "founder";
/** The three cosmetics the pack gives (the fourth thing, the badge, is the Genesis number itself). */
export const FOUNDER_ITEM_IDS = ["founder", "banner-gold-foil", "title-founder"] as const;

/** #0001 style label for a Genesis number. */
export function founderLabel(number: number): string {
  return `#${String(Math.max(0, Math.trunc(number))).padStart(4, "0")}`;
}

/** True while the pack may still be ordered: not past its deadline (a missing deadline never ends). */
export function founderSalesOpen(endsAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!endsAt) return true;
  const end = Date.parse(endsAt);
  return Number.isNaN(end) || now.getTime() <= end;
}

/** How many numbers are taken so far; null when it cannot be read (the table is missing until the SQL is run). */
export async function founderCount(db: Db): Promise<number | null> {
  const { count, error } = await db.from("founders").select("user_id", { count: "exact", head: true });
  return error ? null : count ?? 0;
}

/** A player's Genesis number, or null (also null when it cannot be read: the badge is decoration). */
export async function founderNumberOf(db: Db, userId: string): Promise<number | null> {
  try {
    const { data } = await db.from("founders").select("number").eq("user_id", userId).maybeSingle();
    const number = Number((data as Row | null)?.number);
    return Number.isFinite(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

/** When each of these Shop product ids stops selling (best effort: empty if the column does not exist yet). */
export async function productDeadlines(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error } = await db.from("shop_products").select("id,ends_at").in("id", ids);
  if (error) return out;
  for (const row of (data ?? []) as Row[]) if (row.ends_at) out.set(String(row.id), String(row.ends_at));
  return out;
}

/** Gives the buyer of a paid Genesis order their number and cosmetics. Returns the number. Safe to call twice. */
export async function claimFounder(db: Db, userId: string, orderId: string | null, limit: number): Promise<number> {
  const { data, error } = await db.rpc("founder_claim", { p_user: userId, p_order: orderId, p_limit: limit });
  if (error) {
    if (String(error.message).includes("founder_sold_out")) apiError(409, "All Genesis packs are taken", "founder_sold_out");
    legacyXError(error, "Unable to give the Genesis pack");
  }
  const number = Number(data);
  if (!Number.isFinite(number) || number < 1) apiError(500, "The Genesis number was not saved");
  return number;
}
