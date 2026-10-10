/**
 * The in-game menu's Skins tab (knives and gloves). The game server plugin shows a short list the player
 * clicks through; these helpers keep the rules in one place: which loadout entries an equip replaces,
 * the slot key of an item, and how a catalog name is shown.
 */
import { z } from "zod";

export const MENU_SKIN_SLOTS = ["knife", "glove"] as const;
export type MenuSkinSlot = (typeof MENU_SKIN_SLOTS)[number];
export const MENU_SKIN_PAGE = 12;

export const menuSkinSlotSchema = z.enum(MENU_SKIN_SLOTS);
export const menuSkinTypesQuery = z.object({ steam_id: z.string().regex(/^\d{15,20}$/), slot: menuSkinSlotSchema });
export const menuSkinItemsQuery = z.object({
  steam_id: z.string().regex(/^\d{15,20}$/),
  slot: menuSkinSlotSchema,
  weapon_class: z.string().trim().min(1).max(64),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});
export const menuSkinEquipBody = z.object({
  steam_id: z.string().regex(/^\d{15,20}$/),
  catalog_item_id: z.string().uuid(),
}).strict();

/** "★ Karambit | Fade (Factory New)" -> "Fade"; a plain "★ Karambit" is the vanilla knife. */
export function menuSkinName(displayName: string): string {
  const [, skin] = displayName.split("|");
  if (!skin) return "Vanilla";
  return skin.replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)\s*$/i, "").trim() || "Vanilla";
}

/** Same key the website saves: `knife:507`, `glove:...` (the model's defindex, else its class). */
export function menuSlotKey(slot: MenuSkinSlot, modelDefindex: number | null, weaponClass: string | null): string {
  const raw = String(modelDefindex ?? weaponClass ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `${slot}:${raw}`;
}

export interface LoadoutRow { slot: string; slot_key: string; team_scope: string; catalog_item_id: string }

/**
 * Equip for both teams. The loadout keeps one knife and one glove per team, so a look for both teams
 * replaces every entry of that slot, except the very same one (nothing to do then).
 */
export function entriesReplacedByEquip(rows: LoadoutRow[], slot: MenuSkinSlot, slotKey: string, catalogItemId: string): LoadoutRow[] {
  return rows.filter((row) => row.slot === slot && !(row.slot_key === slotKey && row.team_scope === "all" && row.catalog_item_id === catalogItemId));
}
