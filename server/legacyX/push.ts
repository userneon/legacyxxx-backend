import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { z } from "zod";

/**
 * Push notifications to the iOS app (owner request 2026-11-08). The bell's notifications are the source: a small worker looks for the ones not
 * pushed yet, sends each to the devices of its player through Apple's push service (APNs, HTTP/2 with a signed token) and marks it pushed.
 * Nothing but the notification's own title and text is sent. The key (.p8) is a FILE named in the environment, never a value in the repo.
 *
 *   APNS_KEY_FILE   path of the AuthKey_XXXX.p8 from the Apple Developer account (Keys → Apple Push Notifications service)
 *   APNS_KEY_ID     the key's 10 characters        APNS_TEAM_ID   the team's 10 characters
 *   APNS_TOPIC      the app's bundle id (cc.legacyx.app)
 * Off while any of them is missing.
 */
export type ApnsConfig = { keyFile: string; keyId: string; teamId: string; topic: string };

export function apnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyFile = env.APNS_KEY_FILE?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const topic = env.APNS_TOPIC?.trim() || "cc.legacyx.app";
  if (!keyFile || !keyId || !teamId || !/^[A-Z0-9]{10}$/i.test(keyId) || !/^[A-Z0-9]{10}$/i.test(teamId)) return null;
  return { keyFile, keyId, teamId, topic };
}

export const pushDeviceSchema = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{32,200}$/),
  environment: z.enum(["development", "production"]).default("production"),
}).strict();

const base64Url = (value: Buffer | string) => Buffer.from(value).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The provider token Apple wants: ES256 over {iss: team, iat}, valid for an hour (it is renewed every 40 minutes). */
export function apnsJwt(config: ApnsConfig, now = Date.now(), pem = readFileSync(config.keyFile, "utf8")) {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64Url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signature = createSign("SHA256").update(`${header}.${claims}`).sign({ key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${base64Url(signature)}`;
}

export type PushMessage = { title: string; body: string | null; notificationId: string; kind: string };
export type SendResult = { ok: boolean; status: number; reason: string | null };
export type Sender = (device: { token: string; environment: "development" | "production" }, message: PushMessage) => Promise<SendResult>;

export const apnsPayload = (message: PushMessage) => ({
  aps: { alert: { title: message.title.slice(0, 120), ...(message.body ? { body: message.body.slice(0, 240) } : {}) }, sound: "default" },
  notificationId: message.notificationId,
  kind: message.kind,
});

/** Opens one HTTP/2 connection per server and reuses it; Apple closes idle ones, so a failed one is simply made again. */
export function createApnsSender(config: ApnsConfig): Sender {
  let jwt = { value: "", at: 0 };
  const sessions = new Map<string, http2.ClientHttp2Session>();
  const session = (host: string) => {
    const open = sessions.get(host);
    if (open && !open.closed && !open.destroyed) return open;
    const created = http2.connect(`https://${host}`);
    created.on("error", () => sessions.delete(host));
    created.on("close", () => sessions.delete(host));
    created.unref();
    sessions.set(host, created);
    return created;
  };
  return (device, message) => new Promise<SendResult>((resolve) => {
    if (Date.now() - jwt.at > 40 * 60_000) jwt = { value: apnsJwt(config), at: Date.now() };
    const host = device.environment === "development" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    let request: http2.ClientHttp2Stream;
    try {
      request = session(host).request({ ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${jwt.value}`, "apns-topic": config.topic, "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json" });
    } catch {
      return resolve({ ok: false, status: 0, reason: "connect" });
    }
    let status = 0;
    let text = "";
    request.on("response", (headers) => { status = Number(headers[":status"] ?? 0); });
    request.on("data", (chunk) => { text += String(chunk); });
    request.on("end", () => {
      let reason: string | null = null;
      try { reason = (JSON.parse(text) as { reason?: string }).reason ?? null; } catch { reason = null; }
      resolve({ ok: status === 200, status, reason });
    });
    request.on("error", () => resolve({ ok: false, status: 0, reason: "stream" }));
    request.setTimeout(10_000, () => { request.close(); resolve({ ok: false, status: 0, reason: "timeout" }); });
    request.end(JSON.stringify(apnsPayload(message)));
  });
}

/** Apple says the token is dead (the app was removed, or it is a sandbox token sent to production): forget the device. */
export const deadToken = (result: SendResult) => result.status === 410 || (result.status === 400 && (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"));

type Row = Record<string, unknown>;
export type PushStore = {
  unpushed: (limit: number) => Promise<Array<{ id: string; userId: string; kind: string; title: string; body: string | null }>>;
  devices: (userIds: string[]) => Promise<Array<{ userId: string; token: string; environment: "development" | "production" }>>;
  markPushed: (ids: string[]) => Promise<void>;
  forget: (tokens: string[]) => Promise<void>;
};

/** One pass: send what is waiting, mark it pushed (also when its player has no device, so it is not looked at again), drop dead devices. */
export async function pushTick(store: PushStore, send: Sender, limit = 50) {
  const waiting = await store.unpushed(limit);
  if (waiting.length === 0) return { sent: 0, failed: 0, forgotten: 0 };
  const devices = await store.devices(Array.from(new Set(waiting.map((entry) => entry.userId))));
  let sent = 0;
  let failed = 0;
  const dead = new Set<string>();
  for (const entry of waiting) {
    for (const device of devices.filter((candidate) => candidate.userId === entry.userId)) {
      const result = await send(device, { title: entry.title, body: entry.body, notificationId: entry.id, kind: entry.kind });
      if (result.ok) sent += 1;
      else { failed += 1; if (deadToken(result)) dead.add(device.token); }
    }
  }
  await store.markPushed(waiting.map((entry) => entry.id));
  if (dead.size) await store.forget(Array.from(dead));
  return { sent, failed, forgotten: dead.size };
}

/** The store over the API's database client (legacy_x schema). */
export function supabasePushStore(db: () => { from: (table: string) => any }): PushStore {
  const rows = (data: unknown) => (Array.isArray(data) ? (data as Row[]) : []);
  return {
    async unpushed(limit) {
      const since = new Date(Date.now() - 15 * 60_000).toISOString();
      const { data } = await db().from("notifications").select("id,user_id,kind,title,body").is("pushed_at", null).gte("created_at", since).order("created_at").limit(limit);
      return rows(data).map((row) => ({ id: String(row.id), userId: String(row.user_id), kind: String(row.kind), title: String(row.title), body: row.body == null ? null : String(row.body) }));
    },
    async devices(userIds) {
      const { data } = await db().from("push_devices").select("user_id,token,environment").in("user_id", userIds);
      return rows(data).map((row) => ({ userId: String(row.user_id), token: String(row.token), environment: row.environment === "development" ? "development" as const : "production" as const }));
    },
    async markPushed(ids) {
      await db().from("notifications").update({ pushed_at: new Date().toISOString() }).in("id", ids);
    },
    async forget(tokens) {
      await db().from("push_devices").delete().in("token", tokens);
    },
  };
}
