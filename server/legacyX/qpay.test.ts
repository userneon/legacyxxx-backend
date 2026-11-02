import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkQpayInvoice, createQpayInvoice, invoiceIsPaid, qpayConfig, resetQpayTokenForTests } from "./qpay";

const config = { baseUrl: "https://qpay.test", clientId: "id", clientSecret: "secret", invoiceCode: "CODE_INVOICE" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("qpay", () => {
  beforeEach(() => resetQpayTokenForTests());

  it("is off until every merchant setting is present", () => {
    expect(qpayConfig({})).toBeNull();
    expect(qpayConfig({ QPAY_CLIENT_ID: "a", QPAY_CLIENT_SECRET: "b" } as NodeJS.ProcessEnv)).toBeNull();
    expect(qpayConfig({ QPAY_CLIENT_ID: "a", QPAY_CLIENT_SECRET: "b", QPAY_INVOICE_CODE: "c" } as NodeJS.ProcessEnv)?.baseUrl).toBe("https://merchant.qpay.mn");
    expect(qpayConfig({ QPAY_CLIENT_ID: "a", QPAY_CLIENT_SECRET: "b", QPAY_INVOICE_CODE: "c", QPAY_SANDBOX: "true" } as NodeJS.ProcessEnv)?.baseUrl).toBe("https://merchant-sandbox.qpay.mn");
  });

  it("makes an invoice and keeps only safe bank links", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/v2/auth/token")
      ? json({ access_token: "tok", expires_in: Math.floor(Date.now() / 1000) + 3600 })
      : json({ invoice_id: "inv-1", qr_text: "qr", qr_image: "b64", qPay_shortUrl: "https://qpay.mn/s/1", urls: [
        { name: "Khan Bank", description: "Хаан банк", logo: "https://x/logo.png", link: "khanbank://q?qPay_QRcode=1" },
        { name: "Bad", description: "", logo: "", link: "javascript://alert(1)" },
      ] }));
    const invoice = await createQpayInvoice(config, { senderNo: "n1", description: "d", amount: 5000, callbackUrl: "https://api.test/cb" }, fetcher as unknown as typeof fetch);
    expect(invoice.invoiceId).toBe("inv-1");
    expect(invoice.links.map((link) => link.name)).toEqual(["Khan Bank"]);
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("/v2/invoice"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({ invoice_code: "CODE_INVOICE", sender_invoice_no: "n1", amount: 5000 });
  });

  it("counts only PAID payments and needs the whole price", async () => {
    const fetcher = async (url: string) => url.endsWith("/v2/auth/token") ? json({ access_token: "t" }) : json({ rows: [{ payment_id: "p1", payment_status: "PAID", payment_amount: 4000 }, { payment_id: "p2", payment_status: "NEW", payment_amount: 1000 }] });
    const check = await checkQpayInvoice(config, "inv-1", fetcher as unknown as typeof fetch);
    expect(check).toEqual({ paid: true, paidAmount: 4000, paymentId: "p1" });
    expect(invoiceIsPaid(check, 5000)).toBe(false);
    expect(invoiceIsPaid(check, 4000)).toBe(true);
  });
});
