import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWireCheckout, createWireIntent, intentIsPaid, verifyWireSignature, wireConfig } from "./wire";

const config = { apiUrl: "https://api.test", apiKey: "sk_live_x" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("wire", () => {
  it("is off until a key is set", () => {
    expect(wireConfig({})).toBeNull();
    expect(wireConfig({ WIRE_API_KEY: "sk_live_a" } as NodeJS.ProcessEnv)?.apiUrl).toBe("https://api.wire.mn");
  });

  it("creates an intent with an idempotency key and then a checkout page", async () => {
    const fetcher = vi.fn(async (url: string) => String(url).endsWith("/v1/payment_intents") ? json({ id: "pi_1", status: "requires_payment_method", amount: 5000, currency: "MNT" }) : json({ id: "cs_1", url: "https://pay.wire.mn/c/cs_1" }));
    const intent = await createWireIntent(config, { amount: 5000, description: "LX", topupId: "t1", key: "topup-t1-intent" }, fetcher as unknown as typeof fetch);
    expect(intent.id).toBe("pi_1");
    const first = fetcher.mock.calls[0][1] as RequestInit;
    expect((first.headers as Record<string, string>)["Idempotency-Key"]).toBe("topup-t1-intent");
    expect(JSON.parse(first.body as string)).toMatchObject({ amount: 5000, currency: "MNT", metadata: { topup_id: "t1" } });
    expect(await createWireCheckout(config, { intentId: "pi_1", successUrl: "https://x/ok", cancelUrl: null, key: "k" }, fetcher as unknown as typeof fetch)).toBe("https://pay.wire.mn/c/cs_1");
  });

  it("refuses a checkout page that is not https", async () => {
    const fetcher = async () => json({ url: "javascript:alert(1)" });
    await expect(createWireCheckout(config, { intentId: "pi_1", successUrl: null, cancelUrl: null, key: "k" }, fetcher as unknown as typeof fetch)).rejects.toThrow();
  });

  it("counts an intent as paid only when succeeded, in MNT, for the whole price", () => {
    expect(intentIsPaid({ id: "a", status: "succeeded", amount: 5000, currency: "MNT" }, 5000)).toBe(true);
    expect(intentIsPaid({ id: "a", status: "succeeded", amount: 4000, currency: "MNT" }, 5000)).toBe(false);
    expect(intentIsPaid({ id: "a", status: "requires_action", amount: 5000, currency: "MNT" }, 5000)).toBe(false);
  });

  it("checks the webhook signature and its age", () => {
    const body = '{"type":"payment_intent.succeeded"}';
    const now = 1_800_000_000_000;
    const t = now / 1000;
    expect(verifyWireSignature(body, sign("whsec_a", t, body), "whsec_a", now)).toBe(true);
    expect(verifyWireSignature(body, sign("whsec_b", t, body), "whsec_a", now)).toBe(false);
    expect(verifyWireSignature(body + " ", sign("whsec_a", t, body), "whsec_a", now)).toBe(false);
    expect(verifyWireSignature(body, sign("whsec_a", t - 400, body), "whsec_a", now)).toBe(false);
    expect(verifyWireSignature(body, undefined, "whsec_a", now)).toBe(false);
    expect(verifyWireSignature(body, "garbage", "whsec_a", now)).toBe(false);
  });
});
