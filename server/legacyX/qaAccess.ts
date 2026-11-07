import type { SupabaseClient } from "@supabase/supabase-js";
import { legacyXError } from "./supabase";

type Db = SupabaseClient<any, any, any, any, any>;

/** The `cosmetic_owned.source` of an item a QA tester holds only for testing (owner request 2026-11-07: QA tries everything in the Shop). */
export const QA_SOURCE = "qa";

type Held = { item_id: string; expires_at: string | null };

/**
 * The items a QA tester still lacks: every item sold or earned, switched on or off, that they do not hold now. An item they already hold for good
 * or rent is left alone; an expired row is replaced.
 */
export function itemsToGrant(allItemIds: string[], held: Held[], now = Date.now()): string[] {
  const running = new Set(held.filter((row) => !row.expires_at || Date.parse(row.expires_at) > now).map((row) => row.item_id));
  return allItemIds.filter((id) => !running.has(id));
}

/** A staff row makes a QA tester when its role is QA, or when any other role carries the tester switch (so an Owner can test the Shop too). */
export const isQaRow = (row: { role?: string; qa?: boolean } | null | undefined) => Boolean(row) && (row!.role === "QA" || row!.qa === true);

export async function isActiveQa(db: Db, userId: string): Promise<boolean> {
  const { data, error } = await db.from("staff").select("role,qa").eq("user_id", userId).eq("status", "active").maybeSingle();
  legacyXError(error, "Unable to read the staff role");
  return isQaRow(data as { role?: string; qa?: boolean } | null);
}

/** Gives an active QA tester every cosmetic for good, so the Shop, the wardrobe and the game servers all treat it as theirs. */
export async function grantQaCosmetics(db: Db, userId: string): Promise<void> {
  const [items, held] = await Promise.all([
    db.from("cosmetic_items").select("id,unlock").neq("unlock", "free").limit(5000),
    db.from("cosmetic_owned").select("item_id,expires_at").eq("user_id", userId).limit(5000),
  ]);
  legacyXError(items.error || held.error, "Unable to read the cosmetics for QA");
  const missing = itemsToGrant(((items.data ?? []) as Array<{ id: string }>).map((item) => item.id), (held.data ?? []) as Held[]);
  if (missing.length === 0) return;
  const { error } = await db.from("cosmetic_owned").upsert(missing.map((id) => ({ user_id: userId, item_id: id, source: QA_SOURCE, expires_at: null, acquired_at: new Date().toISOString() })), { onConflict: "user_id,item_id" });
  legacyXError(error, "Unable to give QA the cosmetics");
}

/** Takes the testing items back from everyone who is no longer an active QA tester (their own purchases are never touched). */
export async function revokeStaleQaCosmetics(db: Db): Promise<void> {
  const [holders, qa] = await Promise.all([
    db.from("cosmetic_owned").select("user_id").eq("source", QA_SOURCE).limit(100000),
    db.from("staff").select("user_id").or("role.eq.QA,qa.eq.true").eq("status", "active").limit(1000),
  ]);
  legacyXError(holders.error || qa.error, "Unable to check the QA cosmetics");
  const active = new Set(((qa.data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id));
  const stale = Array.from(new Set(((holders.data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id))).filter((id) => !active.has(id));
  // A paid rank a tester switched on for free goes the same way.
  const rankHolders = await db.from("perk_grants").select("user_id").eq("qa", true).limit(100000);
  legacyXError(rankHolders.error, "Unable to check the QA ranks");
  for (const row of (rankHolders.data ?? []) as Array<{ user_id: string }>) {
    if (!active.has(row.user_id)) {
      const { error } = await db.from("perk_grants").delete().eq("user_id", row.user_id).eq("qa", true);
      legacyXError(error, "Unable to take the QA rank back");
    }
  }
  for (const userId of stale) {
    const { error } = await db.from("cosmetic_owned").delete().eq("user_id", userId).eq("source", QA_SOURCE);
    legacyXError(error, "Unable to take the QA cosmetics back");
    // Whatever they were wearing that they no longer own comes off as well.
    const worn = await db.from("cosmetic_equipped").select("kind,item_id").eq("user_id", userId);
    const owned = await db.from("cosmetic_owned").select("item_id").eq("user_id", userId);
    const keep = new Set(((owned.data ?? []) as Array<{ item_id: string }>).map((row) => row.item_id));
    const free = await db.from("cosmetic_items").select("id").eq("unlock", "free");
    for (const id of ((free.data ?? []) as Array<{ id: string }>)) keep.add(id.id);
    for (const row of ((worn.data ?? []) as Array<{ kind: string; item_id: string }>)) if (!keep.has(row.item_id)) await db.from("cosmetic_equipped").delete().eq("user_id", userId).eq("kind", row.kind);
  }
}
