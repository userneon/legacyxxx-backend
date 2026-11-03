import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Wire (https://wire.mn, docs at https://docs.wire.mn) is the payment gateway for LX top-ups (owner request 2026-11-03): QPay and the other
 * Mongolian operators sit behind it. A top-up is a PaymentIntent plus a hosted checkout page; the LX are added once Wire says the intent is
 * `succeeded` (read from its API, never taken from the browser). Keys come from the environment only: WIRE_API_KEY (sk_live_…),
 * WIRE_WEBHOOK_SECRET (whsec_…), optional WIRE_API_URL.
 */
export type WireConfig = { apiUrl: string; apiKey: string };

export function wireConfig(env: NodeJS.ProcessEnv = process.env): WireConfig | null {
  const apiKey = env.WIRE_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiUrl: (env.WIRE_API_URL?.trim() || "https://api.wire.mn").replace(/\/$/, ""), apiKey };
}
export const wireWebhookSecret = (env: NodeJS.ProcessEnv = process.env) => env.WIRE_WEBHOOK_SECRET?.trim() || null;

export class WireError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "") { super(message); }
}

type Fetch = typeof fetch;
const text = (value: unknown) => (typeof value === "string" ? value : "");

async function wireCall(config: WireConfig, fetcher: Fetch, method: "GET" | "POST", path: string, payload?: unknown, idempotencyKey?: string) {
  const response = await fetcher(`${config.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.apiKey}`, ...(payload ? { "Content-Type": "application/json" } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
    throw new WireError(`Wire answered ${response.status}${text(error.code) ? ` ${text(error.code)}` : ""}${text(error.message) ? `: ${text(error.message).slice(0, 200)}` : ""}`, response.status, text(error.code).replace(/[^a-z0-9_]/gi, "").slice(0, 60));
  }
  return body;
}

export type WireIntent = { id: string; status: string; amount: number; currency: string };
const intentOf = (body: Record<string, unknown>): WireIntent => ({ id: text(body.id), status: text(body.status), amount: Number(body.amount) || 0, currency: text(body.currency) });

/** The money to collect for one top-up. `key` makes a repeated call return the same intent. */
export async function createWireIntent(config: WireConfig, input: { amount: number; description: string; topupId: string; key: string }, fetcher: Fetch = fetch): Promise<WireIntent> {
  const intent = intentOf(await wireCall(config, fetcher, "POST", "/v1/payment_intents", { amount: input.amount, currency: "MNT", description: input.description.slice(0, 200), metadata: { topup_id: input.topupId } }, input.key));
  if (!intent.id) throw new WireError("Wire did not return a payment");
  return intent;
}

/** Wire's hosted payment page for an intent (QR, bank-app links, operator choice). */
export async function createWireCheckout(config: WireConfig, input: { intentId: string; successUrl: string | null; cancelUrl: string | null; key: string }, fetcher: Fetch = fetch): Promise<string> {
  const body = await wireCall(config, fetcher, "POST", "/v1/checkout/sessions", { payment_intent: input.intentId, ...(input.successUrl ? { success_url: input.successUrl } : {}), ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}) }, input.key);
  const url = text(body.url);
  if (!/^https:\/\/[^\s]+$/.test(url)) throw new WireError("Wire did not return a payment page");
  return url;
}

export async function getWireIntent(config: WireConfig, intentId: string, fetcher: Fetch = fetch): Promise<WireIntent> {
  return intentOf(await wireCall(config, fetcher, "GET", `/v1/payment_intents/${encodeURIComponent(intentId)}`));
}

/** A paid intent: Wire says succeeded, in tugrik, for at least the whole price. */
export const intentIsPaid = (intent: WireIntent, amountMnt: number) => intent.status === "succeeded" && intent.currency === "MNT" && intent.amount >= amountMnt;

/** Checks `WirePayment-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256(secret, "<t>.<raw body>"), and that it is not older than five minutes. */
export function verifyWireSignature(rawBody: Buffer | string, header: string | undefined, secret: string, now = Date.now(), toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => { const at = part.indexOf("="); return [part.slice(0, at).trim(), part.slice(at + 1).trim()]; }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/i.test(parts.v1 ?? "")) return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1, "hex"));
}
