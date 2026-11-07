import type { CSSProperties } from "react"

import { C, DISPLAY } from "./theme"

/** LEGACY-X as text, the "-X" in soft violet. */
export const Wordmark = ({ size, style }: { size: number; style?: CSSProperties }) => (
  <span style={{ fontFamily: DISPLAY, fontSize: size, lineHeight: 1, letterSpacing: "0.02em", color: C.text, whiteSpace: "nowrap", ...style }}>
    LEGACY-<span style={{ color: C.bright }}>X</span>
  </span>
)
