import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearHostAddressCacheForTests, numericAddress } from "./hostAddress";

describe("numericAddress", () => {
  beforeEach(() => clearHostAddressCacheForTests());
  it("turns a host name into its IPv4 address, once per five minutes", async () => {
    const lookup = vi.fn(async () => "203.0.113.7");
    expect(await numericAddress("cs.legacyx.cc:27015", lookup, 1000)).toBe("203.0.113.7:27015");
    expect(await numericAddress("cs.legacyx.cc:27015", lookup, 2000)).toBe("203.0.113.7:27015");
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("leaves numeric, empty and unreadable addresses alone, and falls back when the lookup fails", async () => {
    const lookup = vi.fn(async () => { throw new Error("nope"); });
    expect(await numericAddress("1.2.3.4:27015", lookup)).toBe("1.2.3.4:27015");
    expect(await numericAddress(null, lookup)).toBeNull();
    expect(await numericAddress("not an address", lookup)).toBe("not an address");
    expect(await numericAddress("down.example:27015", lookup)).toBe("down.example:27015");
  });
});
