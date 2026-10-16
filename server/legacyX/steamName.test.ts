import { describe, expect, it } from "vitest";
import { nameCandidates } from "./steamProfile";

describe("nameCandidates", () => {
  it("tries the Steam name first, then with the end of the Steam ID", () => {
    expect(nameCandidates("7", "76561199851887452")).toEqual(["7", "7 7452", "7 51887452"]);
  });
  it("keeps long names within the limit and never returns an empty name", () => {
    const long = "x".repeat(80);
    expect(nameCandidates(long, "76561199851887452").every((name) => name.length <= 64)).toBe(true);
    expect(nameCandidates("  ", "76561199851887452")[0]).toBe("Player");
  });
});
