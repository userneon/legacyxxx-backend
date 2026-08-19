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
});
