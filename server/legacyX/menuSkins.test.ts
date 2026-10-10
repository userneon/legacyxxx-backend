import { describe, expect, it } from "vitest";
import { entriesReplacedByEquip, menuSkinEquipBody, menuSkinItemsQuery, menuSkinName, menuSlotKey } from "./menuSkins";

describe("menuSkinName", () => {
  it("drops the knife name and the wear", () => {
    expect(menuSkinName("★ Karambit | Fade (Factory New)")).toBe("Fade");
    expect(menuSkinName("★ Sport Gloves | Amphibious (Battle-Scarred)")).toBe("Amphibious");
  });
  it("calls an item without a skin the vanilla one", () => {
    expect(menuSkinName("★ Karambit")).toBe("Vanilla");
  });
});

describe("menuSlotKey", () => {
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

describe("request schemas", () => {
  it("requires a steam id, a class and a uuid", () => {
    expect(menuSkinItemsQuery.safeParse({ steam_id: "76561198000000000", slot: "knife", weapon_class: "Karambit" }).success).toBe(true);
    expect(menuSkinItemsQuery.safeParse({ steam_id: "x", slot: "knife", weapon_class: "Karambit" }).success).toBe(false);
    expect(menuSkinEquipBody.safeParse({ steam_id: "76561198000000000", catalog_item_id: "nope" }).success).toBe(false);
    expect(menuSkinEquipBody.safeParse({ steam_id: "76561198000000000", catalog_item_id: "0b6e1b0e-6d0b-4a4b-8d1a-1f5e6a8f7c11", extra: 1 }).success).toBe(false);
  });
});
