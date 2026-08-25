import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

type RequestWithCorrelation = Request & { legacyxRequestId?: string; legacyxStartedAt?: number };
type ParserError = Error & { status?: number; statusCode?: number; type?: string };

const clientRequestIdPattern = /^[A-Za-z0-9_-]{8,128}$/;

function requestIdFor(req: RequestWithCorrelation) {
  const supplied = req.header("x-request-id")?.trim();
  return supplied && clientRequestIdPattern.test(supplied) ? supplied : randomUUID();
}

export function apiSecurityMiddleware(req: RequestWithCorrelation, res: Response, next: NextFunction) {
  const requestId = requestIdFor(req);
  req.legacyxRequestId = requestId;
  req.legacyxStartedAt = Date.now();
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.on("finish", () => {
    if (res.statusCode < 400) return;
    console.warn(JSON.stringify({
      event: "api_request",
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - (req.legacyxStartedAt ?? Date.now()),
    }));
  });
  next();
}

export function apiParseErrorHandler(error: ParserError, req: RequestWithCorrelation, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);
  const status = error.type === "entity.too.large" || error.status === 413 || error.statusCode === 413 ? 413 : 400;
  if (status >= 500) console.error("[legacy-x-api] parser failure", { requestId: req.legacyxRequestId, type: error.type });
  res.status(status).json({ error: status === 413 ? "Request body is too large" : "Malformed request body", requestId: req.legacyxRequestId ?? null });
}
