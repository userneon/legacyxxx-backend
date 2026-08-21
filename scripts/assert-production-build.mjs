import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const entrypoint = resolve(process.cwd(), "dist", "index.js");

try {
  await access(entrypoint, constants.R_OK);
} catch {
  console.error("[startup] Production build artifact is missing: dist/index.js");
  console.error("[startup] Run the deployment build step first: npm run build");
  process.exit(1);
}
