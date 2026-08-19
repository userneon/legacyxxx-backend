import { afterEach, describe, expect, it } from "vitest";
import { apiRateLimitMax, runtimeHost, runtimePort, trustProxyValue } from "./config";

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
    expect(apiRateLimitMax()).toBe(120);
  });

  it("rejects invalid runtime ports and rate limits", () => {
    process.env.PORT = "70000";
    expect(() => runtimePort()).toThrow(/PORT/);

    process.env.API_RATE_LIMIT_MAX = "0";
    expect(() => apiRateLimitMax()).toThrow(/API_RATE_LIMIT_MAX/);
  });
});
