import type { CSSProperties } from "react"

import { C } from "./theme"

/**
 * The round-cornered "L" of the LEGACY-X mark as vector paths, so it stays sharp at any size. Traced from the owner's 128 px picture (public/logolegacyx.webp
 * on the website): two slanted shapes, the upright and the base. Replace these two paths if the owner supplies the original vector.
 */
export const STEM = "M319.0 64.0 L313.0 64.0 L298.0 74.0 L135.0 208.0 L114.0 230.0 L96.0 264.0 L91.0 305.0 L92.0 910.0 L97.0 917.0 L106.0 914.0 L296.0 733.0 L309.0 715.0 L319.0 691.0 L323.0 669.0 L324.0 144.0 L323.0 70.0 Z"
export const BASE = "M123.0 963.0 L132.0 967.0 L626.0 967.0 L654.0 962.0 L694.0 945.0 L715.0 931.0 L909.0 763.0 L922.0 746.0 L919.0 742.0 L910.0 740.0 L403.0 741.0 L383.0 745.0 L358.0 756.0 L327.0 779.0 L134.0 946.0 L123.0 958.0 Z"

/** The mark; `stem` and `base` are 0..1 and slide each piece in from its own side (the upright from above, the base from the left). */
export const Mark = ({ size, stem = 1, base = 1, color = C.text, style }: { size: number; stem?: number; base?: number; color?: string; style?: CSSProperties }) => (
  <svg viewBox="0 0 1024 1024" width={size} height={size} style={{ overflow: "visible", ...style }}>
    <path d={STEM} fill={color} style={{ transform: `translateY(${(1 - stem) * -700}px)`, opacity: Math.min(1, stem * 2) }} />
    <path d={BASE} fill={color} style={{ transform: `translateX(${(1 - base) * -900}px)`, opacity: Math.min(1, base * 2) }} />
  </svg>
)
