import { describe, expect, it } from "vitest";
import { defaultServerName, resolveServerName, serverNameSchema } from "./serverHeartbeat";

/** A tiny stand-in for the table: one row per server, enough for the three queries resolveServerName makes. */
function fakeServers(rows: Array<{ server_id: string; current_mode: string; site_name: string | null }>, failRead = false) {
  const db: any = {
    from() {
      let op = "select"; let patch: any = null; let head = false; const eq: Record<string, unknown> = {}; let nullOnly = false; let notNull = false;
      const builder: any = {
        select(_cols?: string, options?: { head?: boolean }) { head = Boolean(options?.head); return builder; },
        update(next: any) { op = "update"; patch = next; return builder; },
        eq(column: string, value: unknown) { eq[column] = value; return builder; },
        is() { nullOnly = true; return builder; },
        not() { notNull = true; return builder; },
        maybeSingle: async () => (failRead ? { data: null, error: { message: "no column" } } : { data: rows.find((row) => row.server_id === eq.server_id) ?? null, error: null }),
        then(resolve: (value: unknown) => void) {
          if (op === "update") {
            const hit = rows.filter((row) => row.server_id === eq.server_id && (!nullOnly || row.site_name === null));
            hit.forEach((row) => Object.assign(row, { site_name: patch.site_name }));
            return resolve({ data: hit.map((row) => ({ site_name: row.site_name })), error: null });
          }
          const hit = rows.filter((row) => (eq.current_mode === undefined || row.current_mode === eq.current_mode) && (!notNull || row.site_name !== null));
          return resolve({ data: head ? null : hit, count: hit.length, error: null });
        },
      };
      return builder;
    },
  };
  return db;
}

describe("a server's name belongs to the website", () => {
  it("names a server after its mode and counts up", () => {
    expect(defaultServerName("fun", 2)).toBe("Fun #2");
    expect(defaultServerName("competitive_5v5", 1)).toBe("5x5 #1");
    expect(defaultServerName("", 3)).toBe("LEGACY-X #3");
  });

  it("gives a new server a default name on its first heartbeat, and keeps it afterwards", async () => {
    const rows = [{ server_id: "srv-1", current_mode: "fun", site_name: "Fun #1" }, { server_id: "srv-2", current_mode: "fun", site_name: null }];
    const db = fakeServers(rows);
    expect(await resolveServerName(db, "srv-2", "fun")).toBe("Fun #2");
    expect(await resolveServerName(db, "srv-2", "fun")).toBe("Fun #2");
    expect(rows[1]!.site_name).toBe("Fun #2");
  });

  it("keeps a name staff gave and never reads the one the game reports", async () => {
    const db = fakeServers([{ server_id: "srv-1", current_mode: "fun", site_name: "Arena" }]);
    expect(await resolveServerName(db, "srv-1", "fun")).toBe("Arena");
  });

  it("answers with no name when the column is not there yet", async () => {
    expect(await resolveServerName(fakeServers([{ server_id: "srv-1", current_mode: "fun", site_name: null }], true), "srv-1", "fun")).toBeNull();
  });

  it("accepts names that are safe in a console and refuses the rest", () => {
    expect(serverNameSchema.safeParse("LEGACY-X | Fun #1").success).toBe(true);
    expect(serverNameSchema.safeParse("Мөнгөн хэт #2").success).toBe(true);
    for (const bad of ["", "a;b", 'a"b', "a\\b", "a$b", "x".repeat(61)]) expect(serverNameSchema.safeParse(bad).success).toBe(false);
  });
});
