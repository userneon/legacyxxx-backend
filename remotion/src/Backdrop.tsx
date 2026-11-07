import { AbsoluteFill } from "remotion"

import { C } from "./theme"

/** The dark picture of the site: violet light from a corner, a faint grid. */
export const Backdrop = ({ shift = 0 }: { shift?: number }) => (
  <AbsoluteFill style={{ background: C.bg }}>
    <AbsoluteFill style={{ background: `radial-gradient(60% 70% at ${85 - shift}% 100%, rgba(139,92,246,.55), transparent 70%), radial-gradient(40% 45% at 10% 0%, rgba(167,139,250,.18), transparent 70%)` }} />
    <AbsoluteFill style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)", backgroundSize: "80px 80px", maskImage: "linear-gradient(180deg, transparent, #000 40%, #000 70%, transparent)" }} />
  </AbsoluteFill>
)
