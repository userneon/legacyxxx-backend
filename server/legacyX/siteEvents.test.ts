import { describe, expect, it } from "vitest";
import { activeSiteEvent, siteEventSchema, ulaanbaatarDay, type SiteEventRecord } from "./siteEvents";

const rec = (over: Partial<SiteEventRecord>): SiteEventRecord => ({ id: "1", theme: "halloween", title: "Halloween", starts_on: "2026-10-25", ends_on: "2026-11-01", enabled: true, ...over });

describe("site events", () => {
  it("uses the Ulaanbaatar day, which is eight hours ahead of UTC", () => {
    expect(ulaanbaatarDay(new Date("2026-10-31T16:30:00Z"))).toBe("2026-11-01");
    expect(ulaanbaatarDay(new Date("2026-10-31T15:59:00Z"))).toBe("2026-10-31");
  });

  it("includes the first and the last day and nothing outside them", () => {
    const list = [rec({})];
    expect(activeSiteEvent(list, "2026-10-24")).toBeNull();
    expect(activeSiteEvent(list, "2026-10-25")?.theme).toBe("halloween");
    expect(activeSiteEvent(list, "2026-11-01")?.theme).toBe("halloween");
    expect(activeSiteEvent(list, "2026-11-02")).toBeNull();
  });

  it("ignores events that are switched off or have an unknown theme", () => {
    expect(activeSiteEvent([rec({ enabled: false })], "2026-10-28")).toBeNull();
    expect(activeSiteEvent([rec({ theme: "easter" })], "2026-10-28")).toBeNull();
  });

  it("lets the event that started later win when two overlap", () => {
    const list = [rec({ id: "a", theme: "new-year", title: "New Year", starts_on: "2026-12-20", ends_on: "2027-01-05" }), rec({ id: "b", theme: "tsagaan-sar", title: "Tsagaan Sar", starts_on: "2027-01-03", ends_on: "2027-01-10" })];
    expect(activeSiteEvent(list, "2027-01-04")?.id).toBe("b");
    expect(activeSiteEvent(list, "2026-12-25")?.id).toBe("a");
  });

  it("checks the input", () => {
    expect(siteEventSchema.safeParse({ theme: "halloween", title: "Halloween", startsOn: "2026-10-25", endsOn: "2026-11-01" }).success).toBe(true);
    expect(siteEventSchema.safeParse({ theme: "halloween", title: "x", startsOn: "2026-11-01", endsOn: "2026-10-25" }).success).toBe(false);
    expect(siteEventSchema.safeParse({ theme: "halloween", title: "x", startsOn: "2026-02-30", endsOn: "2026-03-02" }).success).toBe(false);
    expect(siteEventSchema.safeParse({ theme: "halloween", title: "x", startsOn: "2026-01-01", endsOn: "2026-06-01" }).success).toBe(false);
    expect(siteEventSchema.safeParse({ theme: "easter", title: "x", startsOn: "2026-01-01", endsOn: "2026-01-02" }).success).toBe(false);
  });
});
