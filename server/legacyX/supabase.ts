import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient<any, any, any, any, any> | null = null;

export function legacyXDb(): SupabaseClient<any, any, any, any, any> {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase server credentials are not configured");
  }

  client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    db: { schema: "legacy_x" },
  });

  return client;
}

export function legacyXError(error: { message?: string; code?: string } | null, fallback: string): never | void {
  if (!error) return;
  const safeMessages: Record<string, string> = {
    "23505": "A record with that value already exists",
    "23503": "A referenced record does not exist",
    "23514": "The request did not satisfy a data constraint",
    "22023": "The request contains invalid parameters",
    P0001: "The requested operation conflicts with the current data state",
    P0002: "The requested resource was not found",
  };
  const message = error.code ? safeMessages[error.code] ?? fallback : fallback;
  const code = error.code === "23505" || error.code === "P0001"
    ? 409
    : error.code === "23503" || error.code === "23514" || error.code === "22023"
      ? 400
      : error.code === "P0002"
        ? 404
        : 500;
  const apiError = new Error(message) as Error & { statusCode?: number };
  apiError.statusCode = code;
  throw apiError;
}
