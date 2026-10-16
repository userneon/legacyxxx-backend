import { beforeEach, describe, expect, it } from "vitest";
import { cachedFor, clearResponseCache } from "./responseCache";

beforeEach(() => clearResponseCache());

describe("cachedFor", () => {
  it("builds once within the time to live and again after it", async () => {
    let calls = 0;
    let time = 1_000;
    const load = async () => ++calls;
    expect(await cachedFor("a", 10_000, load, () => time)).toBe(1);
    time += 5_000;
    expect(await cachedFor("a", 10_000, load, () => time)).toBe(1);
    time += 6_000;
    expect(await cachedFor("a", 10_000, load, () => time)).toBe(2);
  });
  it("lets callers that arrive during a build share it", async () => {
    let calls = 0;
    const load = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return "x"; };
    const results = await Promise.all([cachedFor("b", 10_000, load), cachedFor("b", 10_000, load), cachedFor("b", 10_000, load)]);
    expect(results).toEqual(["x", "x", "x"]);
    expect(calls).toBe(1);
  });
  it("gives the last good answer when a rebuild fails, and an error when there is none", async () => {
    let time = 0;
    await cachedFor("c", 1_000, async () => "good", () => time);
    time = 5_000;
    expect(await cachedFor("c", 1_000, async () => { throw new Error("db down"); }, () => time)).toBe("good");
    await expect(cachedFor("d", 1_000, async () => { throw new Error("db down"); })).rejects.toThrow("db down");
  });
});
