/**
 * The in-game menu's Skins tab (knives, gloves, guns and agents). The game server plugin shows a short list the player
 * clicks through; these helpers keep the rules in one place: which loadout entries an equip replaces, the slot key of an
 * item, and how a catalog name is shown.
 */
import { z } from "zod";

export const MENU_SKIN_SLOTS = ["knife", "glove", "weapon", "agent"] as const;
export type MenuSkinSlot = (typeof MENU_SKIN_SLOTS)[number];
export const MENU_GUN_GROUPS = ["Rifles", "SMGs", "Heavy", "Pistols"] as const;
export const MENU_AGENT_TEAMS = ["Terrorist", "Counter-Terrorist"] as const;
export const MENU_SKIN_PAGE = 12;

/** The catalog category a skin of this slot has (a gun's skins are `weapon_skin`, its plain model is `weapon`). */
export const MENU_SLOT_CATEGORY: Record<MenuSkinSlot, string> = { knife: "knife", glove: "glove", weapon: "weapon_skin", agent: "agent" };

export const menuSkinSlotSchema = z.enum(MENU_SKIN_SLOTS);
const steamId = z.string().regex(/^\d{15,20}$/);
export const menuSkinTypesQuery = z.object({
  steam_id: steamId,
  slot: menuSkinSlotSchema,
  group: z.enum(MENU_GUN_GROUPS).optional(),
});
export const menuSkinItemsQuery = z.object({
  steam_id: steamId,
  slot: menuSkinSlotSchema,
  /** A knife / glove / gun class ("Karambit", "AK-47"), or the team of the agents ("Terrorist"). */
  weapon_class: z.string().trim().min(1).max(64),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});
export const menuSkinEquipBody = z.object({
  steam_id: steamId,
  catalog_item_id: z.string().uuid(),
}).strict();

/** "★ Karambit | Fade (Factory New)" -> "Fade"; a plain "★ Karambit" is the vanilla knife. */
export function menuSkinName(displayName: string): string {
  const [, skin] = displayName.split("|");
  if (!skin) return "Vanilla";
  return skin.replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)\s*$/i, "").trim() || "Vanilla";
}

/** "'Medium Rare' Crasswater | Guerrilla Warfare" -> "'Medium Rare' Crasswater". */
export function menuAgentName(displayName: string): string {
  return displayName.split("|")[0]!.trim() || displayName.trim();
}

/** The plain gun's model name in the game's files: "cs2:weapon:base_weapon-weapon_ak47" -> "ak47". */
export function menuGunModel(externalKey: string | null | undefined): string | null {
  const match = /base_weapon-weapon_([a-z0-9_]+)$/.exec(externalKey ?? "");
  return match ? match[1]! : null;
}

/** Same key the website saves: `knife:507`, `weapon:7`, `glove:...` (the model's defindex, else its class), and plain `agent`. */
export function menuSlotKey(slot: MenuSkinSlot, modelDefindex: number | null, weaponClass: string | null): string {
  if (slot === "agent") return "agent";
  const raw = String(modelDefindex ?? weaponClass ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `${slot}:${raw}`;
}

export interface LoadoutRow { slot: string; slot_key: string; team_scope: string; catalog_item_id: string }

/**
 * What a pick replaces. The loadout keeps one knife and one glove per team, so a knife or glove for both teams replaces
 * every entry of that slot (except the very same one). A gun has its own entry per model: the same model for the other
 * team scope would double up, so it goes. An agent is one per team and the save replaces it by itself.
 */
export function entriesReplacedByEquip(rows: LoadoutRow[], slot: MenuSkinSlot, slotKey: string, catalogItemId: string, teamScope = "all"): LoadoutRow[] {
  if (slot === "agent") return [];
  if (slot === "weapon") return rows.filter((row) => row.slot === "weapon" && row.slot_key === slotKey && row.team_scope !== teamScope);
  return rows.filter((row) => row.slot === slot && !(row.slot_key === slotKey && row.team_scope === "all" && row.catalog_item_id === catalogItemId));
}
