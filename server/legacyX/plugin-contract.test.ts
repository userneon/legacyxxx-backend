import { describe, expect, it } from "vitest";
import { liveMatchSnapshotV1Schema } from "./routes";

const baseSnapshot = {
  schema_version: 1,
  snapshot_revision: 7,
  captured_at: "2026-08-24T15:00:00.000Z",
  state: "live",
  map_name: "de_nuke",
  round_number: 14,
  score_t: 7,
  score_ct: 6,
  terrorist_players: [{ steam_id: "76561198000000001", name: "T Player", connected: true, adr: 82.4, ping: 24, rank_id: 12, rank_name: "Legendary Eagle", rank_image_key: "rank-12" }],
  counter_terrorist_players: [{ steam_id: "76561198000000002", name: "CT Player", connected: true }],
  spectator_players: [],
};

describe("live match snapshot v1 contract", () => {
  it("accepts a complete real-data snapshot with optional player metrics", () => {
    expect(liveMatchSnapshotV1Schema.parse(baseSnapshot)).toMatchObject(baseSnapshot);
  });

  it("rejects unknown version, uncorrelated snapshot and unbounded player values", () => {
    expect(liveMatchSnapshotV1Schema.safeParse({ ...baseSnapshot, schema_version: 2 }).success).toBe(false);
    expect(liveMatchSnapshotV1Schema.safeParse({ ...baseSnapshot, snapshot_revision: -1 }).success).toBe(false);
    expect(liveMatchSnapshotV1Schema.safeParse({ ...baseSnapshot, terrorist_players: [{ ...baseSnapshot.terrorist_players[0], ping: 1_001 }] }).success).toBe(false);
  });
});
