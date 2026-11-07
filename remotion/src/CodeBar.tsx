import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"

import { Wordmark } from "./Wordmark"
import { C, TEXT } from "./theme"

export type CodeProps = { code: string }

/** "Creator code" bar: slides in from the right, the code types in letter by letter, a light runs over it, slides out. Transparent. 150 frames at 30 fps. */
export const CodeBar = ({ code }: CodeProps) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 17, stiffness: 110 }, durationInFrames: 30 })
  const leave = interpolate(frame, [durationInFrames - 26, durationInFrames - 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) })
  const x = interpolate(enter, [0, 1], [1200, 0]) + leave * 1300
  const letters = Math.min(code.length, Math.max(0, Math.floor((frame - 30) / 4)))
  const sweep = interpolate(frame, [60, 90], [-30, 130], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: "50%", bottom: 90, marginLeft: -450, width: 900, height: 96, display: "flex", background: "rgba(10,10,10,.9)", border: "1px solid rgba(255,255,255,.16)", transform: `translateX(${x}px)`, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "0 34px", background: C.brand, fontFamily: TEXT, fontWeight: 700, fontSize: 30, letterSpacing: "0.12em", textTransform: "uppercase", color: C.on }}>Creator code</div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: TEXT, fontWeight: 700, fontSize: 52, letterSpacing: "0.3em", color: C.text, paddingLeft: "0.3em" }}>
          {code.split("").map((ch, index) => <span key={index} style={{ opacity: index < letters ? 1 : 0.14 }}>{index < letters ? ch : "•"}</span>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", padding: "0 30px", borderLeft: "1px solid rgba(255,255,255,.16)" }}><Wordmark size={34} /></div>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${sweep}%`, width: 120, background: "linear-gradient(100deg, transparent, rgba(255,255,255,.22), transparent)", transform: "skewX(-20deg)" }} />
      </div>
    </AbsoluteFill>
  )
}
