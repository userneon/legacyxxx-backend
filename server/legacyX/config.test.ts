import { afterEach, describe, expect, it } from "vitest";
import { apiRateLimitMax, apiSessionRateLimitMax, runtimeHost, runtimePort, trustProxyValue } from "./config";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("VPS runtime configuration", () => {
  it("uses safe local-Nginx defaults", () => {
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.TRUST_PROXY;
    delete process.env.API_RATE_LIMIT_MAX;

    expect(runtimePort()).toBe(3000);
    expect(runtimeHost()).toBe("127.0.0.1");
    expect(trustProxyValue()).toBe(1);
    expect(apiRateLimitMax()).toBe(600);
    expect(apiSessionRateLimitMax()).toBe(600);
  });

  it("rejects invalid runtime ports and rate limits", () => {
    process.env.PORT = "70000";
    expect(() => runtimePort()).toThrow(/PORT/);

    process.env.API_RATE_LIMIT_MAX = "0";
    expect(() => apiRateLimitMax()).toThrow(/API_RATE_LIMIT_MAX/);
  });
});

describe("cooldownsActive", () => {
  const launch = Date.parse("2026-12-01T00:00:00Z");
  it("is off until the launch day and on from then", async () => {
    const { cooldownsActive } = await import("./config");
    expect(cooldownsActive(launch - 1, "2026-12-01T00:00:00Z")).toBe(false);
    expect(cooldownsActive(launch, "2026-12-01T00:00:00Z")).toBe(true);
  });
  it("can be forced on or off, and an unreadable date falls back to the launch day", async () => {
    const { cooldownsActive } = await import("./config");
    expect(cooldownsActive(0, "now")).toBe(true);
    expect(cooldownsActive(launch + 1e9, "never")).toBe(false);
    expect(cooldownsActive(launch - 1, "soon")).toBe(false);
    expect(cooldownsActive(launch, "soon")).toBe(true);
  });
});
