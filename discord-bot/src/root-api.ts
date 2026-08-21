import { config } from "./config.js";

export class RootApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function apiGet<T>(path: string, options: { token?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token && config.LEGACYX_BOT_API_TOKEN) headers.Authorization = `Bearer ${config.LEGACYX_BOT_API_TOKEN}`;
  const response = await fetch(`${config.apiUrl}/api/v1${path}`, { headers, signal: AbortSignal.timeout(12_000) });
  const payload = await response.json().catch(() => ({})) as { error?: string; message?: string } & T;
  if (!response.ok) throw new RootApiError(response.status, payload.message ?? payload.error ?? "LEGACY-X API request failed");
  return payload;
}

export function compactNumber(value: number | undefined) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value ?? 0);
}
