// Renders the ready-made (the same for everyone) transparent animations of the Creator kit into a folder:
//   REMOTION_BROWSER=<chrome> node render-static.mjs <outdir>        e.g. ../../legacyxxx-frontend/public/creator-kit/video
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] ?? join(here, "static"))
mkdirSync(out, { recursive: true })
const files = { CommunityIntro: "community-intro.webm", LogoSting: "logo-sting.webm", Wipe: "wipe-transition.webm", CommunityBug: "community-badge.webm" }
for (const [id, file] of Object.entries(files)) {
  console.log("rendering", id)
  execFileSync(process.execPath, [join(here, "render.mjs"), id, join(out, file), "{}"], { stdio: "inherit", env: process.env })
}
