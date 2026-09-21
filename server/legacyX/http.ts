import type { NextFunction, Request, Response } from "express";
import { parseCookieHeader } from "../_core/cookieHeader";
import { verifyAccessToken, type LegacyUser, type PluginPrincipal } from "./auth";

export type ApiRequest = Request & { legacyUser?: LegacyUser; plugin?: PluginPrincipal };
export type AsyncHandler = (req: ApiRequest, res: Response, next: NextFunction) => Promise<void>;

export function apiError(statusCode: number, message: string): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  throw error;
}

export function asyncRoute(handler: AsyncHandler) {
  return (req: ApiRequest, res: Response, next: NextFunction) => void handler(req, res, next).catch(next);
}

export function bearer(req: Request) {
  const value = req.header("authorization");
  if (value?.startsWith("Bearer ")) return value.slice(7).trim();
  const cookieToken = parseCookieHeader(req.headers.cookie ?? "").legacyx_access_token;
  if (cookieToken) return cookieToken;
  apiError(401, "Bearer token is required");
}

export async function requireUser(req: ApiRequest) {
  const user = await verifyAccessToken(bearer(req));
  req.legacyUser = user;
  return user;
}

export function userRoute(handler: (req: ApiRequest, res: Response, user: LegacyUser) => Promise<void>) {
  return asyncRoute(async (req, res) => handler(req, res, await requireUser(req)));
}

export function hasAccessToken(req: Request) {
  return Boolean(req.header("authorization")?.startsWith("Bearer ") || parseCookieHeader(req.headers.cookie ?? "").legacyx_access_token);
}
