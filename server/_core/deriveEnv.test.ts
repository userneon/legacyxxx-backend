import { describe, expect, it } from "vitest";
import { deriveEnv } from "./deriveEnv";

describe("deriveEnv", () => {
  it("fills every address from DOMAIN and STAFF_PANEL", () => {
    const env: NodeJS.ProcessEnv = { DOMAIN: "https://lxc.mn/", STAFF_PANEL: "https://staff.lxc.mn" };
    deriveEnv(env);
    expect(env.FRONTEND_ORIGIN).toBe("https://lxc.mn");
    expect(env.PUBLIC_API_ORIGIN).toBe("https://api.lxc.mn");
    expect(env.AUTH_COOKIE_DOMAIN).toBe(".lxc.mn");
    expect(env.ADMIN_ORIGIN).toBe("https://staff.lxc.mn");
    expect(env.DISCORD_OAUTH_REDIRECT_URI).toBe("https://api.lxc.mn/api/v1/auth/discord/callback");
    expect(env.TIKTOK_REDIRECT_URI).toBe("https://api.lxc.mn/api/v1/auth/tiktok/callback");
  });

  it("never overrides a value that is already set", () => {
    const env: NodeJS.ProcessEnv = { DOMAIN: "https://lxc.mn", FRONTEND_ORIGIN: "https://other.example", API_URL: "https://x.lxc.mn" };
    deriveEnv(env);
    expect(env.FRONTEND_ORIGIN).toBe("https://other.example");
    expect(env.PUBLIC_API_ORIGIN).toBe("https://x.lxc.mn");
  });

  it("does nothing without DOMAIN or with a broken one", () => {
    const empty: NodeJS.ProcessEnv = {};
    deriveEnv(empty);
    expect(empty).toEqual({});
    const broken: NodeJS.ProcessEnv = { DOMAIN: "not a url" };
    deriveEnv(broken);
    expect(broken.FRONTEND_ORIGIN).toBeUndefined();
  });
});
