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
export const MENU_SKIN_PAGE = 9;

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

// ---- the loadout overview (like the website's Skinchanger page) -----------------------------------------------

export const MENU_TEAMS = ["t", "ct"] as const;
export type MenuTeam = (typeof MENU_TEAMS)[number];
export const menuLoadoutQuery = z.object({ steam_id: steamId, team: z.enum(MENU_TEAMS) });

/** Guns only one team can buy; the rest are for both. Same lists as the website uses. */
const T_ONLY_GUNS = new Set(["AK-47", "Galil AR", "SG 553", "G3SG1", "Glock-18", "Tec-9", "MAC-10", "Sawed-Off"]);
const CT_ONLY_GUNS = new Set(["AUG", "FAMAS", "M4A1-S", "M4A4", "SCAR-20", "USP-S", "P2000", "Five-SeveN", "MP9", "MAG-7"]);

/** The overview has five columns; guns go to the first four in this order, the fifth holds Agent, Gloves and Knife. */
export const MENU_COLUMN_GUNS: string[][] = [
  ["Glock-18", "USP-S", "P2000", "P250", "Five-SeveN", "Tec-9", "CZ75-Auto", "Desert Eagle", "Dual Berettas", "R8 Revolver"],
  ["MAC-10", "MP9", "MP7", "MP5-SD", "UMP-45", "P90", "PP-Bizon"],
  ["AK-47", "M4A4", "M4A1-S", "Galil AR", "FAMAS", "SG 553", "AUG", "AWP", "SSG 08", "SCAR-20", "G3SG1"],
  ["Nova", "XM1014", "Sawed-Off", "MAG-7", "M249", "Negev"],
];

export function gunIsForTeam(weaponClass: string, team: MenuTeam): boolean {
  if (team === "t") return !CT_ONLY_GUNS.has(weaponClass);
  return !T_ONLY_GUNS.has(weaponClass);
}

export interface MenuTile { column: number; slot: MenuSkinSlot; weaponClass: string; label: string; model: string | null }

/** The tiles a team sees, column by column. `models` maps a gun class to its model name ("AK-47" -> "ak47"). */
export function menuTiles(team: MenuTeam, models: Map<string, string | null>): MenuTile[] {
  const tiles: MenuTile[] = [];
  MENU_COLUMN_GUNS.forEach((column, index) => {
    for (const weaponClass of column) {
      if (!models.has(weaponClass) || !gunIsForTeam(weaponClass, team)) continue;
      tiles.push({ column: index, slot: "weapon", weaponClass, label: weaponClass, model: models.get(weaponClass) ?? null });
    }
  });
  tiles.push({ column: 4, slot: "agent", weaponClass: team === "t" ? "Terrorist" : "Counter-Terrorist", label: "Agent", model: null });
  tiles.push({ column: 4, slot: "glove", weaponClass: "", label: "Gloves", model: null });
  tiles.push({ column: 4, slot: "knife", weaponClass: "", label: "Knife", model: null });
  return tiles;
}

/** "Mil-Spec Grade" -> "milspec" ... the class the menu's rarity dot and line use (CS2 rarity colours only as a thin mark). */
export function menuRarity(rarity: unknown): string | null {
  const value = String(rarity ?? "").toLowerCase();
  if (!value) return null;
  if (value.includes("contraband")) return "contraband";
  if (value.includes("extraordinary")) return "extraordinary";
  // Agents have their own names for the same ladder.
  if (value.includes("master")) return "covert";
  if (value.includes("superior")) return "classified";
  if (value.includes("exceptional")) return "restricted";
  if (value.includes("distinguished")) return "milspec";
  if (value.includes("covert")) return "covert";
  if (value.includes("classified")) return "classified";
  if (value.includes("restricted")) return "restricted";
  if (value.includes("mil")) return "milspec";
  if (value.includes("industrial")) return "industrial";
  if (value.includes("consumer") || value.includes("base")) return "consumer";
  return null;
}
