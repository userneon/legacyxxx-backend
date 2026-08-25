import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiParseErrorHandler, apiSecurityMiddleware } from "./security";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(apiSecurityMiddleware);
  app.post("/echo", express.json({ limit: "1kb" }), (req, res) => res.json({ received: req.body }));
  app.use(apiParseErrorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe("API security middleware", () => {
  it("sets a safe universal header set and preserves a valid client request ID", async () => {
    const requestId = "legacyx-security-test-001";
    const response = await fetch(`${baseUrl}/echo`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: "{}" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("returns a safe 400 for malformed JSON without parser internals", async () => {
    const response = await fetch(`${baseUrl}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not-json" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Malformed request body" });
  });

  it("rejects oversized request bodies", async () => {
    const response = await fetch(`${baseUrl}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: "x".repeat(2_048) }) });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "Request body is too large" });
  });
});
