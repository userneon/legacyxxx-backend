import { describe, expect, it } from "vitest";
import { legacyXDb, legacyXError } from "./supabase";
import { syncSteamUserProfile, validateSteamWebApiKey } from "./steamProfile";

const describeWithSteamIntegration = process.env.STEAM_WEB_API_KEY && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? describe : describe.skip;

describeWithSteamIntegration("Steam Web API credential", () => {
  it("validates the server-only Steam Web API key with Steam's lightweight server-info endpoint", async () => {
    await expect(validateSteamWebApiKey()).resolves.toBeUndefined();
  }, 20_000);

  it("updates an existing Steam user in place without creating a duplicate", async () => {
    const { data: existing, error } = await legacyXDb().from("users").select("id,steam_id").order("created_at").limit(1).maybeSingle();
    legacyXError(error, "Unable to read an existing Steam user for profile sync verification");
    expect(existing).toBeTruthy();
    if (!existing) return;

    const { count: beforeCount, error: beforeError } = await legacyXDb().from("users").select("id", { count: "exact", head: true }).eq("steam_id", existing.steam_id);
    legacyXError(beforeError, "Unable to count existing Steam users before profile sync");
    const synced = await syncSteamUserProfile(existing.steam_id);
    const { count: afterCount, error: afterError } = await legacyXDb().from("users").select("id", { count: "exact", head: true }).eq("steam_id", existing.steam_id);
    legacyXError(afterError, "Unable to count existing Steam users after profile sync");

    expect(afterCount).toBe(beforeCount);
    expect(synced.user.id).toBe(existing.id);
    expect(synced.user.steam_id).toBe(existing.steam_id);
    expect(synced.user.username).toBe(synced.profile.username);
    expect(synced.user.avatar).toBe(synced.profile.avatar);
    expect(synced.user.level).toBeDefined();
    expect(synced.user.rank).toBeDefined();
  }, 30_000);
});
