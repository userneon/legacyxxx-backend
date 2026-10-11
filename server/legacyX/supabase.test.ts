import { describe, expect, it } from "vitest";
import { legacyXError } from "./supabase";

describe("Supabase error boundary", () => {
  it("maps database conflicts to a safe client response without leaking raw database text", () => {
    try {
      legacyXError({ code: "23505", message: "duplicate key value violates unique constraint internal_table_pkey" }, "Unable to save record");
      throw new Error("Expected legacyXError to throw");
    } catch (error) {
      const apiError = error as Error & { statusCode?: number };
      expect(apiError.statusCode).toBe(409);
      expect(apiError.message).toBe("A record with that value already exists");
      expect(apiError.message).not.toContain("internal_table_pkey");
    }
  });

  it("passes our own database messages through and keeps Postgres's own text hidden", () => {
    const thrown = (error: { code: string; message: string }) => {
      try { legacyXError(error, "Unable to save"); } catch (caught) { return caught as Error & { statusCode?: number }; }
      throw new Error("Expected legacyXError to throw");
    };
    expect(thrown({ code: "P0001", message: "Clan is full" })).toMatchObject({ message: "Clan is full", statusCode: 409 });
    expect(thrown({ code: "22023", message: "Loadout contains an unsupported catalog item" })).toMatchObject({ message: "Loadout contains an unsupported catalog item", statusCode: 400 });
    expect(thrown({ code: "22023", message: "invalid parameter value for internal_column" }).message).toBe("The request contains invalid parameters");
  });
});
