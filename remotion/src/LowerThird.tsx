import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"

import { C, DISPLAY, TEXT } from "./theme"

export type NameProps = { name: string }

/** The creator's name bar: slides in from the left, holds, slides back out. Transparent (render as WebM with alpha). 150 frames at 30 fps. */
export const LowerThird = ({ name }: NameProps) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 120 }, durationInFrames: 28 })
  const leave = interpolate(frame, [durationInFrames - 26, durationInFrames - 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) })
  const x = interpolate(enter, [0, 1], [-900, 0]) - leave * 1000
  const reveal = interpolate(frame, [14, 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) })
  const accent = interpolate(frame, [4, 20], [0, 120], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) })
  const size = name.length > 16 ? 40 : 52
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 80, bottom: 110, display: "flex", height: 120, transform: `translateX(${x}px)` }}>
        <div style={{ width: 10, height: accent, alignSelf: "flex-end", background: C.brand }} />
        <div style={{ minWidth: 760, padding: "0 36px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 10, background: "linear-gradient(90deg, rgba(10,10,10,.94), rgba(10,10,10,.6))", borderTop: "1px solid rgba(255,255,255,.12)", borderBottom: "1px solid rgba(255,255,255,.12)" }}>
          <div style={{ overflow: "hidden", height: 56 }}>
            <div style={{ fontFamily: TEXT, fontWeight: 700, fontSize: size, color: C.text, lineHeight: "56px", transform: `translateY(${(1 - reveal) * 60}px)`, opacity: reveal, whiteSpace: "nowrap" }}>{name}</div>
          </div>
          <div style={{ fontFamily: TEXT, fontWeight: 500, fontSize: 26, color: C.dim, letterSpacing: "0.06em", textTransform: "uppercase", opacity: interpolate(frame, [26, 44], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
            Content Creator · <span style={{ fontFamily: DISPLAY, fontSize: 24, color: C.text }}>LEGACY-<span style={{ color: C.bright }}>X</span></span>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}
