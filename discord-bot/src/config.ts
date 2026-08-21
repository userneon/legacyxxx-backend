import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(20),
  DISCORD_APPLICATION_ID: z.string().min(5),
  DISCORD_GUILD_ID: z.string().min(5).optional(),
  LEGACYX_API_URL: z.string().url().default("https://api.legacyx.cc"),
  LEGACYX_BOT_API_TOKEN: z.string().min(16).optional(),
  DISCORD_STAFF_ROLE_IDS: z.string().optional(),
  DISCORD_REPORT_CHANNEL_ID: z.string().min(5).optional(),
  DISCORD_ANNOUNCEMENT_CHANNEL_ID: z.string().min(5).optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const fields = parsed.error.issues.map(issue => issue.path.join(".")).join(", ");
  throw new Error(`Invalid Discord bot environment variables: ${fields}`);
}

export const config = {
  ...parsed.data,
  apiUrl: parsed.data.LEGACYX_API_URL.replace(/\/$/, ""),
  staffRoleIds: new Set((parsed.data.DISCORD_STAFF_ROLE_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean)),
};
