/**
 * One place for the site's addresses (owner request 2026-11-15: "write the same thing once").
 *
 * Set DOMAIN (the website, e.g. https://lxc.mn) and STAFF_PANEL (the staff site) in .env and every address the API
 * needs follows from them. A variable that is already set is never touched, so an older .env keeps working and one
 * address can still be overridden on its own (API_URL when the API does not live on api.<domain>).
 */
const clean = (value: string | undefined) => value?.trim().replace(/\/+$/, "") || "";

export function deriveEnv(env: NodeJS.ProcessEnv = process.env) {
  const domain = clean(env.DOMAIN);
  if (!domain) return;
  let host: string;
  try {
    host = new URL(domain).hostname;
  } catch {
    return;
  }
  const api = clean(env.API_URL) || `https://api.${host}`;
  const fallback: Record<string, string> = {
    API_URL: api,
    FRONTEND_ORIGIN: domain,
    POST_LOGIN_REDIRECT: domain,
    PUBLIC_API_ORIGIN: api,
    STEAM_OPENID_ORIGIN: api,
    STATIC_ASSET_BASE_URL: api,
    AUTH_COOKIE_DOMAIN: `.${host}`,
    DISCORD_OAUTH_REDIRECT_URI: `${api}/api/v1/auth/discord/callback`,
    TIKTOK_REDIRECT_URI: `${api}/api/v1/auth/tiktok/callback`,
  };
  const staff = clean(env.STAFF_PANEL);
  if (staff) fallback.ADMIN_ORIGIN = staff;
  for (const [name, value] of Object.entries(fallback)) {
    if (!env[name]?.trim()) env[name] = value;
  }
}
