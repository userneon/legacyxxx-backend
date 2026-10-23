import { describe, expect, it } from "vitest";
import { planPodium } from "./boosterRewards";

describe("booster podium", () => {
  it("gives gold, silver and bronze to the top three and nothing else changes", () => {
    const plan = planPodium(["a", "b", "c"], [], []);
    expect(plan.grant).toEqual([{ userId: "a", itemId: "booster-gold" }, { userId: "b", itemId: "booster-silver" }, { userId: "c", itemId: "booster-bronze" }]);
    expect(plan.revoke).toEqual([]);
    expect(plan.equip).toEqual([]);
  });

  it("is idle when the frames are already where they belong", () => {
    const owned = [{ userId: "a", itemId: "booster-gold" }, { userId: "b", itemId: "booster-silver" }];
    const plan = planPodium(["a", "b", null], owned, [{ userId: "a", itemId: "booster-gold" }]);
    expect(plan).toEqual({ grant: [], revoke: [], equip: [], unequip: [] });
  });

  it("moves a frame with the place: a member who drops from gold to silver wears silver", () => {
    const owned = [{ userId: "a", itemId: "booster-gold" }, { userId: "b", itemId: "booster-silver" }];
    const plan = planPodium(["b", "a", null], owned, [{ userId: "a", itemId: "booster-gold" }, { userId: "b", itemId: "booster-silver" }]);
    expect(plan.revoke).toEqual([{ userId: "a", itemId: "booster-gold" }, { userId: "b", itemId: "booster-silver" }]);
    expect(plan.grant).toEqual([{ userId: "b", itemId: "booster-gold" }, { userId: "a", itemId: "booster-silver" }]);
    expect(plan.equip).toEqual([{ userId: "a", itemId: "booster-silver" }, { userId: "b", itemId: "booster-gold" }]);
    expect(plan.unequip).toEqual([]);
  });

  it("takes the frame off a member who falls off the podium", () => {
    const owned = [{ userId: "a", itemId: "booster-bronze" }];
    const plan = planPodium([null, null, null], owned, [{ userId: "a", itemId: "booster-bronze" }]);
    expect(plan.revoke).toEqual(owned);
    expect(plan.unequip).toEqual([{ userId: "a", itemId: "booster-bronze" }]);
  });

  it("leaves places empty when fewer than three boosters qualify", () => {
    expect(planPodium(["a", null, null], [], []).grant).toEqual([{ userId: "a", itemId: "booster-gold" }]);
  });
});

import { boosterPlaceOf } from "./boosterRewards";

describe("booster place", () => {
  const dbWith = (items: string[], fail = false) => ({ from: () => ({ select: () => ({ eq: () => ({ in: async () => { if (fail) throw new Error("down"); return { data: items.map((item_id) => ({ item_id })), error: null }; } }) }) }) }) as never;
  it("reads the place from the podium frame the player holds", async () => {
    await expect(boosterPlaceOf(dbWith(["booster-gold"]), "u")).resolves.toBe(1);
    await expect(boosterPlaceOf(dbWith(["booster-silver"]), "u")).resolves.toBe(2);
    await expect(boosterPlaceOf(dbWith(["booster-bronze"]), "u")).resolves.toBe(3);
    await expect(boosterPlaceOf(dbWith([]), "u")).resolves.toBeNull();
  });
  it("is null when the database cannot be read", async () => {
    await expect(boosterPlaceOf(dbWith([], true), "u")).resolves.toBeNull();
  });
});
