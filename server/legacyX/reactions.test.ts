import { describe, expect, it } from "vitest";
import { isReaction, tallyReactions } from "./reactions";

describe("review reactions", () => {
  it("knows the three reactions and nothing else", () => {
    expect(isReaction("like")).toBe(true);
    expect(isReaction("love")).toBe(true);
    expect(isReaction("funny")).toBe(true);
    expect(isReaction("angry")).toBe(false);
    expect(isReaction(null)).toBe(false);
  });
  it("counts per review and finds the viewer's own pick", () => {
    const tally = tallyReactions([
      { feedback_id: "a", user_id: "u1", reaction: "like" },
      { feedback_id: "a", user_id: "u2", reaction: "like" },
      { feedback_id: "a", user_id: "u3", reaction: "love" },
      { feedback_id: "b", user_id: "u1", reaction: "funny" },
      { feedback_id: "b", user_id: "u9", reaction: "angry" },
    ], "u1");
    expect(tally.summaryFor("a")).toEqual({ reactions: { like: 2, love: 1, funny: 0 }, myReaction: "like" });
    expect(tally.summaryFor("b")).toEqual({ reactions: { like: 0, love: 0, funny: 1 }, myReaction: "funny" });
    expect(tally.summaryFor("c")).toEqual({ reactions: { like: 0, love: 0, funny: 0 }, myReaction: null });
  });
  it("shows no own pick to a guest", () => {
    expect(tallyReactions([{ feedback_id: "a", user_id: "u1", reaction: "like" }], null).summaryFor("a").myReaction).toBeNull();
  });
});
