const productionRequired = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STEAM_WEB_API_KEY",
  "JWT_SECRET",
  "PUBLIC_API_ORIGIN",
  "STATIC_ASSET_BASE_URL",
  "STEAM_OPENID_ORIGIN",
  "FRONTEND_ORIGIN",
  "POST_LOGIN_REDIRECT",
] as const;

function requireValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validateHttpsUrl(name: string) {
  const value = requireValue(name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  return value.replace(/\/$/, "");
}

export function validateProductionRuntime() {
  for (const name of productionRequired) requireValue(name);

  validateHttpsUrl("SUPABASE_URL");
  validateHttpsUrl("PUBLIC_API_ORIGIN");
  validateHttpsUrl("STATIC_ASSET_BASE_URL");
  validateHttpsUrl("STEAM_OPENID_ORIGIN");
  validateHttpsUrl("FRONTEND_ORIGIN");
  validateHttpsUrl("POST_LOGIN_REDIRECT");

  if (requireValue("JWT_SECRET").length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters in production");
  }
}

export function runtimePort() {
  const value = process.env.PORT ?? "3000";
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  return port;
}

export function runtimeHost() {
  return process.env.HOST?.trim() || "127.0.0.1";
}

export function trustProxyValue() {
  const value = process.env.TRUST_PROXY?.trim();
  if (!value) return 1;
  const hops = Number.parseInt(value, 10);
  return Number.isInteger(hops) && hops >= 0 ? hops : 1;
}

export function apiRateLimitMax() {
  const value = process.env.API_RATE_LIMIT_MAX ?? "120";
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("API_RATE_LIMIT_MAX must be an integer between 1 and 10000");
  }
  return limit;
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number) {
  const value = process.env[name] ?? String(fallback);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function apiAuthRateLimitMax() {
  return boundedEnvInt("API_AUTH_RATE_LIMIT_MAX", 30, 1, 1_000);
}

export function apiSensitiveRateLimitMax() {
  return boundedEnvInt("API_SENSITIVE_RATE_LIMIT_MAX", 45, 1, 1_000);
}

export function apiBodyLimit() {
  return `${boundedEnvInt("API_BODY_LIMIT_KB", 1024, 16, 5_120)}kb`;
}
