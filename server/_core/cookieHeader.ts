import * as cookieModule from "cookie";

type CookieMap = Record<string, string | undefined>;
type CookieParser = (header: string) => CookieMap;

const parseCandidate = (cookieModule as unknown as { parseCookie?: CookieParser }).parseCookie;

if (typeof parseCandidate !== "function") {
  throw new Error("Installed cookie package does not expose the required parseCookie function");
}

const parse: CookieParser = parseCandidate;

export function parseCookieHeader(header: string): CookieMap {
  return parse(header);
}
