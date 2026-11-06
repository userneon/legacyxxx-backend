import { describe, expect, it } from "vitest";
import { anticheatFlagSchema, decideAnticheatAction, detectorTier, recordAnticheatFlag, type AnticheatState } from "./anticheat";

const input = (extra: Record<string, unknown> = {}) => anticheatFlagSchema.parse({ steamId: "76561198000000001", detector: "Aimbot", serverId: "srv-27015", ...extra });
const calm: AnticheatState = { isStaff: false, alreadyBanned: false, earlierDetections: 0, otherPlayersRecently: 0 };

describe("anti-cheat decisions", () => {
  it("sorts detectors by how sure they are, unknown names last", () => {
    expect(detectorTier("Aimbot")).toBe("heavy");
    expect(detectorTier("Silent Aim")).toBe("heavy");
    expect(detectorTier("Doubletap")).toBe("heavy");
    expect(detectorTier("Bhop")).toBe("medium");
    expect(detectorTier("Inhuman Accuracy")).toBe("medium");
    expect(detectorTier("Namechanger")).toBe("low");
    expect(detectorTier("something new")).toBe("low");
  });

  it("bans at once for a heavy detector and only flags a low one", () => {
    expect(decideAnticheatAction(input(), calm)).toMatchObject({ action: "ban", reason: "CS2AC: Aimbot" });
    expect(decideAnticheatAction(input({ detector: "Namechanger" }), calm).action).toBe("flag");
  });

  it("bans a medium detector on the second detection within ten minutes, not the first", () => {
    const bhop = input({ detector: "Bhop" });
    expect(decideAnticheatAction(bhop, calm).action).toBe("flag");
    expect(decideAnticheatAction(bhop, { ...calm, earlierDetections: 1 })).toMatchObject({ action: "ban", reason: "CS2AC: Bhop (x2)" });
  });

  it("never bans staff, the already banned, cheat-toy holders, Fun servers or warmup", () => {
    expect(decideAnticheatAction(input(), { ...calm, isStaff: true }).action).toBe("flag");
    expect(decideAnticheatAction(input(), { ...calm, alreadyBanned: true }).action).toBe("flag");
    for (const key of ["cheatToys", "funServer", "warmup"]) expect(decideAnticheatAction(input({ context: { [key]: true } }), calm).action).toBe("flag");
  });

  it("treats the same detector firing on three other players within a minute as the server's fault", () => {
    expect(decideAnticheatAction(input(), { ...calm, otherPlayersRecently: 2 }).action).toBe("ban");
    const decision = decideAnticheatAction(input(), { ...calm, otherPlayersRecently: 3 });
    expect(decision.action).toBe("flag");
    expect(decision.decision).toContain("probably the server");
  });

  it("validates what the game server sends", () => {
    expect(anticheatFlagSchema.safeParse({ steamId: "123", detector: "Aimbot" }).success).toBe(false);
    expect(anticheatFlagSchema.safeParse({ steamId: "76561198000000001", detector: "" }).success).toBe(false);
    expect(input().context).toEqual({ warmup: false, funServer: false, cheatToys: false });
  });
});

/** A database that answers the reads the policy makes and records the insert. */
function fakeDb(rows: { user?: unknown; penalties?: unknown[]; staffCount?: number; earlier?: number; others?: string[] }) {
  const inserted: unknown[] = [];
  const from = (table: string) => {
    const state = { table, op: "select" };
    const builder: any = {
      select: () => builder, eq: () => builder, in: () => builder, neq: () => builder, ilike: () => builder, gte: () => builder, limit: () => builder,
      insert: (payload: unknown) => { inserted.push(payload); state.op = "insert"; return builder; },
      maybeSingle: async () => ({ data: table === "users" ? rows.user ?? null : null, error: null }),
      single: async () => ({ data: { id: "flag-1" }, error: null }),
      then: (resolve: (value: unknown) => unknown) => {
        const answer = table === "penalties" ? { data: rows.penalties ?? [], error: null }
          : table === "staff" ? (rows.staffCount !== undefined ? { count: rows.staffCount, data: [], error: null } : { count: 0, data: [], error: null })
          : table === "anticheat_flags" ? (rows.others ? { data: rows.others.map((steam_id) => ({ steam_id })), count: rows.earlier ?? 0, error: null } : { count: rows.earlier ?? 0, data: [], error: null })
          : { data: [], error: null };
        return Promise.resolve(answer).then(resolve);
      },
    };
    return builder;
  };
  return { db: { from } as any, inserted };
}

describe("recording a detection", () => {
  it("writes the evidence with the decision and returns it", async () => {
    const { db, inserted } = fakeDb({ user: { id: "u1" } });
    const result = await recordAnticheatFlag(db, input({ map: "de_mirage", mode: "competitive_5v5" }));
    expect(result).toMatchObject({ id: "flag-1", action: "ban", reason: "CS2AC: Aimbot" });
    expect(inserted[0]).toMatchObject({ steam_id: "76561198000000001", user_id: "u1", detector: "Aimbot", server_id: "srv-27015", map_name: "de_mirage", action: "ban" });
  });

  it("flags instead of banning when the player has an active ban already", async () => {
    const { db } = fakeDb({ user: { id: "u1" }, penalties: [{ user_id: "u1", is_permanent: true, expires_at: null }] });
    expect((await recordAnticheatFlag(db, input())).action).toBe("flag");
  });
});
