import { describe, expect, it } from "vitest";
import { judgeFact, looksRandom, type CheckFact } from "./checkerJudge";
import { DEFAULT_CHECKER_RULES, mergeCheckerRules, probesOf } from "./checkerRules";

const rules = DEFAULT_CHECKER_RULES;
const fact = (over: Partial<CheckFact> = {}): CheckFact => ({ name: "tool.exe", size: 50_000, signed: false, managed: false, apis: [], game: [], offsets: [], family: [], ...over });

describe("judging what the checker reports", () => {
  it("calls an unsigned program that reads memory, names CS2 and carries offsets a detection, whatever it is called", () => {
    const found = judgeFact(fact({ name: "1780797508681.exe", path: "C:\\Users\\***\\Downloads\\1780797508681.exe", apis: ["openprocess", "readprocessmemory", "createtoolhelp32snapshot"], game: ["cs2.exe", "client.dll"], offsets: ["dwEntityList", "dwViewMatrix"] }), rules);
    expect(found?.confidence).toBe("detection");
    expect(found?.note).toContain("random-looking name");
  });
  it("leaves a signed program alone", () => {
    expect(judgeFact(fact({ signed: true, apis: ["openprocess", "readprocessmemory"], game: ["cs2.exe"], offsets: ["dwEntityList", "dwViewMatrix"] }), rules)).toBeNull();
  });
  it("does not judge by a name: a cheat-like name alone gives nothing, and OpenProcess alone gives nothing", () => {
    expect(judgeFact(fact({ name: "aimbot.exe" }), rules)).toBeNull();
    expect(judgeFact(fact({ apis: ["openprocess"] }), rules)).toBeNull();
  });
  it("needs a CS2 target for a detection, and a name only lowers the bar", () => {
    const memory = fact({ apis: ["openprocess", "readprocessmemory", "createremotethread", "createtoolhelp32snapshot"] });
    expect(judgeFact(memory, rules)?.confidence).toBe("suspicion");
    expect(judgeFact({ ...memory, name: "wallhack-helper.exe", game: [] }, rules)?.confidence).toBe("suspicion");
    expect(judgeFact(fact({ apis: ["openprocess", "readprocessmemory"], game: ["cs2.exe"] }), rules)?.confidence).toBe("suspicion");
    expect(judgeFact(fact({ name: "undetek.exe", apis: ["openprocess", "readprocessmemory", "sendinput"], game: ["cs2.exe"] }), rules)?.confidence).toBe("detection");
  });
  it("recognises a family by its marks, even when the file is signed", () => {
    const custom = mergeCheckerRules({ families: [{ name: "Demo", strings: ["demo window title", "demo.cfg"], minMatches: 2 }] });
    expect(judgeFact(fact({ signed: true, family: ["demo window title", "demo.cfg"] }), custom)?.note).toContain("Demo");
    expect(judgeFact(fact({ family: ["demo.cfg"] }), custom)).toBeNull();
  });
  it("says a program is running now", () => {
    const found = judgeFact(fact({ running: true, apis: ["openprocess", "readprocessmemory"], game: ["cs2.exe"] }), rules);
    expect(found?.kind).toBe("process");
    expect(found?.note.startsWith("Running now.")).toBe(true);
  });
});

describe("random-looking names", () => {
  it("catches digits and jumbles, not ordinary names", () => {
    expect(looksRandom("1780797508681")).toBe(true);
    expect(looksRandom("a3f9k2x81b")).toBe(true);
    expect(looksRandom("steam")).toBe(false);
    expect(looksRandom("Discord")).toBe(false);
    expect(looksRandom("my-tool")).toBe(false);
  });
});

describe("rules", () => {
  it("keeps the built-in value for anything missing or wrong, and never gives the points to the program", () => {
    const merged = mergeCheckerRules({ points: { memory: "lots", game: 5 }, thresholds: { detection: 9 }, apis: { memory: ["x1234"] } });
    expect(merged.points.memory).toBe(3);
    expect(merged.points.game).toBe(5);
    expect(merged.thresholds.detection).toBe(9);
    expect(merged.apis.injection.length).toBeGreaterThan(0);
    const probes = probesOf(merged) as Record<string, unknown>;
    expect(probes.points).toBeUndefined();
    expect(probes.thresholds).toBeUndefined();
    expect(probes.families).toBeUndefined();
    expect(probes.cheatNames).toBeUndefined();
    expect(probes.apis).toContain("openprocess");
  });
});
