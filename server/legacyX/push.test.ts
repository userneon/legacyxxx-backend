import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apnsConfig, apnsJwt, apnsPayload, deadToken, pushDeviceSchema, pushTick, type PushStore, type Sender } from "./push";

describe("push notifications", () => {
  it("is off until the key file, key id and team id are set", () => {
    expect(apnsConfig({})).toBeNull();
    expect(apnsConfig({ APNS_KEY_FILE: "/k.p8", APNS_KEY_ID: "ABCDE12345" })).toBeNull();
    expect(apnsConfig({ APNS_KEY_FILE: "/k.p8", APNS_KEY_ID: "ABCDE12345", APNS_TEAM_ID: "TEAM123456" })).toEqual({ keyFile: "/k.p8", keyId: "ABCDE12345", teamId: "TEAM123456", topic: "cc.legacyx.app" });
    expect(apnsConfig({ APNS_KEY_FILE: "/k.p8", APNS_KEY_ID: "bad", APNS_TEAM_ID: "TEAM123456" })).toBeNull();
  });

  it("signs the provider token with ES256 in the raw 64-byte form Apple reads", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = apnsJwt({ keyFile: "x", keyId: "ABCDE12345", teamId: "TEAM123456", topic: "cc.legacyx.app" }, 1_700_000_000_000, pem);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABCDE12345" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1_700_000_000 });
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    expect(createVerify("SHA256").update(`${header}.${claims}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("sends only the notification's own words and ids", () => {
    expect(apnsPayload({ title: "Penalty", body: null, notificationId: "n1", kind: "penalty" })).toEqual({ aps: { alert: { title: "Penalty" }, sound: "default" }, notificationId: "n1", kind: "penalty" });
    expect(apnsPayload({ title: "x".repeat(500), body: "y".repeat(500), notificationId: "n1", kind: "system" }).aps.alert).toEqual({ title: "x".repeat(120), body: "y".repeat(240) });
  });

  it("checks the token a phone registers", () => {
    expect(pushDeviceSchema.safeParse({ token: "a".repeat(64) }).success).toBe(true);
    expect(pushDeviceSchema.safeParse({ token: "not hex!" }).success).toBe(false);
    expect(pushDeviceSchema.safeParse({ token: "a".repeat(64), environment: "staging" }).success).toBe(false);
    expect(deadToken({ ok: false, status: 410, reason: "Unregistered" })).toBe(true);
    expect(deadToken({ ok: false, status: 400, reason: "BadDeviceToken" })).toBe(true);
    expect(deadToken({ ok: false, status: 503, reason: null })).toBe(false);
  });

  it("pushes each waiting notification to its player's devices, marks all pushed, and forgets dead devices", async () => {
    const marked: string[] = [];
    const forgotten: string[] = [];
    const store: PushStore = {
      unpushed: async () => [{ id: "n1", userId: "u1", kind: "penalty", title: "A", body: null }, { id: "n2", userId: "u2", kind: "system", title: "B", body: "text" }],
      devices: async () => [{ userId: "u1", token: "good", environment: "production" }, { userId: "u1", token: "dead", environment: "development" }],
      markPushed: async (ids) => { marked.push(...ids); },
      forget: async (tokens) => { forgotten.push(...tokens); },
    };
    const calls: string[] = [];
    const send: Sender = async (device, message) => { calls.push(`${device.token}:${message.notificationId}`); return device.token === "dead" ? { ok: false, status: 410, reason: "Unregistered" } : { ok: true, status: 200, reason: null }; };
    expect(await pushTick(store, send)).toEqual({ sent: 1, failed: 1, forgotten: 1 });
    expect(calls).toEqual(["good:n1", "dead:n1"]);
    expect(marked).toEqual(["n1", "n2"]);
    expect(forgotten).toEqual(["dead"]);
  });
});
