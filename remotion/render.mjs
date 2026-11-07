// Renders one Creator kit animation with the name and code given: node render.mjs <LowerThird|CodeBar|EndCard|CodeGif|GlitchGif> <outfile> '{"name":"..","code":".."}'
// Used by the API (server/legacyX/kitRender.ts) and by hand. Transparent ones are WebM (VP9 with alpha), the end card MP4, the stickers GIF.
import { bundle } from "@remotion/bundler"
import { renderMedia, selectComposition } from "@remotion/renderer"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const [id, out, rawProps = "{}"] = process.argv.slice(2)
if (!id || !out) { console.error("usage: node render.mjs <composition> <outfile> [json props]"); process.exit(2) }
const here = dirname(fileURLToPath(import.meta.url))
const props = JSON.parse(rawProps)
const browserExecutable = process.env.REMOTION_BROWSER || undefined
const serveUrl = await bundle({ entryPoint: join(here, "src", "index.ts"), onProgress: () => undefined })
const composition = await selectComposition({ serveUrl, id, inputProps: props, browserExecutable })
const transparent = id === "LowerThird" || id === "CodeBar"
const gif = id.endsWith("Gif")
await renderMedia({
  composition, serveUrl, outputLocation: out, inputProps: props, browserExecutable,
  codec: gif ? "gif" : transparent ? "vp9" : "h264",
  ...(transparent ? { pixelFormat: "yuva420p", imageFormat: "png" } : {}),
  ...(gif ? { everyNthFrame: 1 } : {}),
  concurrency: Number(process.env.REMOTION_CONCURRENCY || 2),
  muted: true,
  logLevel: "error",
})
console.log("done", out)
