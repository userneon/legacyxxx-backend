/**
 * QPay Merchant V2 (https://developer.qpay.mn): the website's LX top-up. A player picks a package, the API makes a QPay invoice,
 * the player pays it in a bank app, and the LX are added once QPay itself says the invoice is paid. The merchant credentials
 * come from the environment only (QPAY_CLIENT_ID, QPAY_CLIENT_SECRET, QPAY_INVOICE_CODE); nothing here is ever sent to the browser.
 */

export type QpayConfig = { baseUrl: string; clientId: string; clientSecret: string; invoiceCode: string };

export type QpayLink = { name: string; description: string; logo: string; link: string };
export type QpayInvoice = { invoiceId: string; qrText: string; qrImage: string; shortUrl: string; links: QpayLink[] };

const SANDBOX = "https://merchant-sandbox.qpay.mn";
const PRODUCTION = "https://merchant.qpay.mn";

/** The merchant settings, or null while QPay is not set up (the top-up then says so instead of pretending). */
export function qpayConfig(env: NodeJS.ProcessEnv = process.env): QpayConfig | null {
  const clientId = env.QPAY_CLIENT_ID?.trim();
  const clientSecret = env.QPAY_CLIENT_SECRET?.trim();
  const invoiceCode = env.QPAY_INVOICE_CODE?.trim();
  if (!clientId || !clientSecret || !invoiceCode) return null;
  const baseUrl = (env.QPAY_BASE_URL?.trim() || (env.QPAY_SANDBOX?.trim().toLowerCase() === "true" ? SANDBOX : PRODUCTION)).replace(/\/$/, "");
  return { baseUrl, clientId, clientSecret, invoiceCode };
}

export class QpayError extends Error {}

type Fetch = typeof fetch;
let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

async function qpayToken(config: QpayConfig, fetcher: Fetch): Promise<string> {
  const key = `${config.baseUrl}|${config.clientId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt - 60_000 > Date.now()) return tokenCache.token;
  const response = await fetcher(`${config.baseUrl}/v2/auth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token) throw new QpayError(`QPay sign-in failed (${response.status})`);
  // expires_in is a Unix time in seconds in QPay's answer; fall back to 10 minutes if it looks like anything else.
  const raw = Number(body.expires_in);
  const expiresAt = raw > 1_000_000_000 ? raw * 1000 : Date.now() + 10 * 60_000;
  tokenCache = { key, token: body.access_token, expiresAt };
  return body.access_token;
}

async function qpayCall(config: QpayConfig, fetcher: Fetch, method: "GET" | "POST", path: string, payload?: unknown) {
  const send = async () => fetcher(`${config.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await qpayToken(config, fetcher)}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  let response = await send();
  if (response.status === 401) {
    tokenCache = null;
    response = await send();
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new QpayError(`QPay answered ${response.status}${typeof body.message === "string" ? `: ${body.message}` : ""}`);
  return body;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Makes an invoice. `senderNo` is our own unique number for it (QPay refuses a repeated one). */
export async function createQpayInvoice(
  config: QpayConfig,
  input: { senderNo: string; description: string; amount: number; callbackUrl: string },
  fetcher: Fetch = fetch,
): Promise<QpayInvoice> {
  const body = await qpayCall(config, fetcher, "POST", "/v2/invoice", {
    invoice_code: config.invoiceCode,
    sender_invoice_no: input.senderNo,
    invoice_receiver_code: "terminal",
    invoice_description: input.description,
    amount: input.amount,
    callback_url: input.callbackUrl,
  });
  const invoiceId = text(body.invoice_id);
  if (!invoiceId) throw new QpayError("QPay did not return an invoice");
  const links = (Array.isArray(body.urls) ? body.urls : [])
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {}))
    .map((entry) => ({ name: text(entry.name), description: text(entry.description), logo: text(entry.logo), link: text(entry.link) }))
    // Only https links and app deep links the banks publish; anything else is dropped before it reaches the page.
    .filter((entry) => entry.name && /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.link) && !/^(javascript|data|file):/i.test(entry.link));
  return { invoiceId, qrText: text(body.qr_text), qrImage: text(body.qr_image), shortUrl: text(body.qPay_shortUrl), links };
}

/** Asks QPay whether the invoice is paid, and how much. QPay is the only source of truth: a callback alone never credits anything. */
export async function checkQpayInvoice(config: QpayConfig, invoiceId: string, fetcher: Fetch = fetch): Promise<{ paid: boolean; paidAmount: number; paymentId: string | null }> {
  const body = await qpayCall(config, fetcher, "POST", "/v2/payment/check", { object_type: "INVOICE", object_id: invoiceId, offset: { page_number: 1, page_size: 100 } });
  const rows = (Array.isArray(body.rows) ? body.rows : []).map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : {}));
  const paidRows = rows.filter((row) => text(row.payment_status).toUpperCase() === "PAID");
  const paidAmount = paidRows.reduce((sum, row) => sum + (Number(row.payment_amount) || 0), 0);
  return { paid: paidRows.length > 0, paidAmount, paymentId: paidRows.length ? text(paidRows[0].payment_id) || null : null };
}

/** An invoice counts as paid only when QPay says PAID for at least the whole price. */
export function invoiceIsPaid(check: { paid: boolean; paidAmount: number }, amountMnt: number) {
  return check.paid && check.paidAmount >= amountMnt;
}

/** Invoices wait this long for the payment before they are shown as expired. */
export const QPAY_INVOICE_MINUTES = 30;
export const resetQpayTokenForTests = () => { tokenCache = null; };

/** A top-up of any amount (owner request 2026-11-02): paid at the smallest package's rate, so a bigger package is always the better deal. */
export const CUSTOM_TOPUP_MIN_MNT = 1000;
export const CUSTOM_TOPUP_MAX_MNT = 500_000;
export const CUSTOM_TOPUP_STEP_MNT = 1000;
export function customTopUpLx(amountMnt: number, base: { priceMnt: number; grantsLx: number }) {
  if (!Number.isInteger(amountMnt) || amountMnt < CUSTOM_TOPUP_MIN_MNT || amountMnt > CUSTOM_TOPUP_MAX_MNT || amountMnt % CUSTOM_TOPUP_STEP_MNT !== 0) return null;
  if (base.priceMnt <= 0 || base.grantsLx <= 0) return null;
  const lx = Math.floor((amountMnt * base.grantsLx) / base.priceMnt);
  return lx > 0 ? lx : null;
}
