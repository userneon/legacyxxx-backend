import { describe, expect, it } from "vitest";
import { entriesReplacedByEquip, menuAgentName, menuGunModel, menuSkinEquipBody, menuSkinItemsQuery, menuSkinName, menuSkinTypesQuery, menuSlotKey } from "./menuSkins";

describe("menuSkinName", () => {
  it("drops the knife name and the wear", () => {
    expect(menuSkinName("★ Karambit | Fade (Factory New)")).toBe("Fade");
    expect(menuSkinName("★ Sport Gloves | Amphibious (Battle-Scarred)")).toBe("Amphibious");
  });
  it("calls an item without a skin the vanilla one", () => {
    expect(menuSkinName("★ Karambit")).toBe("Vanilla");
  });
});

describe("menuAgentName and menuGunModel", () => {
  it("keeps the agent's own name", () => {
    expect(menuAgentName("'Medium Rare' Crasswater | Guerrilla Warfare")).toBe("'Medium Rare' Crasswater");
    expect(menuAgentName("Plain Agent")).toBe("Plain Agent");
  });
  it("reads the model name of a gun", () => {
    expect(menuGunModel("cs2:weapon:base_weapon-weapon_ak47")).toBe("ak47");
    expect(menuGunModel("cs2:weapon:base_weapon-weapon_m4a1_silencer")).toBe("m4a1_silencer");
    expect(menuGunModel(null)).toBeNull();
  });
});

describe("menuSlotKey", () => {
  it("uses weapon:<defindex> for a gun and a plain key for an agent", () => {
    expect(menuSlotKey("weapon", 7, "AK-47")).toBe("weapon:7");
    expect(menuSlotKey("agent", 4613, null)).toBe("agent");
  });
  it("matches the keys the website saves", () => {
    expect(menuSlotKey("knife", 507, "Karambit")).toBe("knife:507");
    expect(menuSlotKey("glove", null, "Sport Gloves")).toBe("glove:sport-gloves");
  });
});

describe("entriesReplacedByEquip", () => {
  const rows = [
    { slot: "knife", slot_key: "knife:500", team_scope: "all", catalog_item_id: "a" },
    { slot: "knife", slot_key: "knife:507", team_scope: "t", catalog_item_id: "b" },
    { slot: "glove", slot_key: "glove:x", team_scope: "all", catalog_item_id: "c" },
    { slot: "weapon", slot_key: "weapon:7", team_scope: "t", catalog_item_id: "d" },
  ];
  it("replaces every knife entry and leaves other slots alone", () => {
    expect(entriesReplacedByEquip(rows, "knife", "knife:507", "z").map((row) => row.catalog_item_id)).toEqual(["a", "b"]);
  });
  it("keeps the identical entry in place", () => {
    expect(entriesReplacedByEquip(rows, "knife", "knife:500", "a").map((row) => row.catalog_item_id)).toEqual(["b"]);
  });
});

describe("entriesReplacedByEquip for guns and agents", () => {
  const rows = [
    { slot: "weapon", slot_key: "weapon:7", team_scope: "all", catalog_item_id: "a" },
    { slot: "weapon", slot_key: "weapon:7", team_scope: "t", catalog_item_id: "b" },
    { slot: "weapon", slot_key: "weapon:9", team_scope: "all", catalog_item_id: "c" },
    { slot: "agent", slot_key: "agent", team_scope: "t", catalog_item_id: "d" },
  ];
  it("drops the same gun for another team scope and keeps other guns", () => {
    expect(entriesReplacedByEquip(rows, "weapon", "weapon:7", "z", "t").map((row) => row.catalog_item_id)).toEqual(["a"]);
    expect(entriesReplacedByEquip(rows, "weapon", "weapon:7", "z", "all").map((row) => row.catalog_item_id)).toEqual(["b"]);
  });
  it("leaves agents to the save", () => {
    expect(entriesReplacedByEquip(rows, "agent", "agent", "z", "t")).toEqual([]);
  });
});

describe("request schemas", () => {
  it("takes a gun group only from the known ones", () => {
    expect(menuSkinTypesQuery.safeParse({ steam_id: "76561198000000000", slot: "weapon", group: "Rifles" }).success).toBe(true);
    expect(menuSkinTypesQuery.safeParse({ steam_id: "76561198000000000", slot: "weapon", group: "Bombs" }).success).toBe(false);
    expect(menuSkinTypesQuery.safeParse({ steam_id: "76561198000000000", slot: "agent" }).success).toBe(true);
  });
  it("requires a steam id, a class and a uuid", () => {
    expect(menuSkinItemsQuery.safeParse({ steam_id: "76561198000000000", slot: "knife", weapon_class: "Karambit" }).success).toBe(true);
    expect(menuSkinItemsQuery.safeParse({ steam_id: "x", slot: "knife", weapon_class: "Karambit" }).success).toBe(false);
    expect(menuSkinEquipBody.safeParse({ steam_id: "76561198000000000", catalog_item_id: "nope" }).success).toBe(false);
    expect(menuSkinEquipBody.safeParse({ steam_id: "76561198000000000", catalog_item_id: "0b6e1b0e-6d0b-4a4b-8d1a-1f5e6a8f7c11", extra: 1 }).success).toBe(false);
  });
});
