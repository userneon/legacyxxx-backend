import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe("Supabase server connection", () => {
  it("accepts the configured server-only credentials", async () => {
    expect(supabaseUrl).toMatch(/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i);
    expect(serviceRoleKey).toBeTruthy();

    const response = await fetch(`${supabaseUrl?.replace(/\/$/, "")}/rest/v1/`, {
      headers: {
        apikey: serviceRoleKey!,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("can query the legacy_x schema used by the API", async () => {
    const client = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
      db: { schema: "legacy_x" },
    });
    const { error } = await client.from("users").select("id").limit(1);

    expect(error).toBeNull();
  });
});
