import { loadFont as loadBlackOps } from "@remotion/google-fonts/BlackOpsOne"
import { loadFont as loadExo } from "@remotion/google-fonts/Exo2"

export const { fontFamily: DISPLAY } = loadBlackOps()
export const { fontFamily: TEXT } = loadExo("normal", { weights: ["500", "700"], subsets: ["latin", "cyrillic"] })

export const C = { bg: "#0a0a0a", panel: "#0f0f0f", text: "#fafafa", dim: "#a3a3a3", brand: "#8b5cf6", bright: "#a78bfa", on: "#f5f3ff" }
