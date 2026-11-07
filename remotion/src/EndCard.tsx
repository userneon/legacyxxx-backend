import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"

import { Backdrop } from "./Backdrop"
import { Wordmark } from "./Wordmark"
import { C, TEXT } from "./theme"

export type EndProps = { name: string; code: string }

/** The last seconds of a video: the wordmark lands, the site and the creator's code come in. Solid picture, 180 frames at 30 fps (MP4). */
export const EndCard = ({ name, code }: EndProps) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const land = spring({ frame: frame - 8, fps, config: { damping: 14, stiffness: 90 } })
  const fade = (from: number, to: number) => interpolate(frame, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) })
  const out = interpolate(frame, [160, 178], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Backdrop shift={interpolate(frame, [0, 180], [0, 25])} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 30 }}>
        <div style={{ fontFamily: TEXT, fontWeight: 500, fontSize: 34, color: C.dim, letterSpacing: "0.3em", textTransform: "uppercase", opacity: fade(4, 22) }}>Play ranked on</div>
        <div style={{ transform: `scale(${interpolate(land, [0, 1], [0.7, 1])})`, opacity: fade(8, 24) }}><Wordmark size={230} /></div>
        <div style={{ fontFamily: TEXT, fontWeight: 700, fontSize: 46, color: C.text, letterSpacing: "0.06em", opacity: fade(34, 52), transform: `translateY(${(1 - fade(34, 52)) * 20}px)` }}>legacyx.cc</div>
        {code && (
          <div style={{ display: "flex", alignItems: "stretch", marginTop: 18, border: "1px solid rgba(255,255,255,.18)", background: "rgba(10,10,10,.8)", opacity: fade(60, 80), transform: `translateY(${(1 - fade(60, 80)) * 24}px)` }}>
            <div style={{ padding: "16px 30px", background: C.brand, fontFamily: TEXT, fontWeight: 700, fontSize: 30, letterSpacing: "0.12em", textTransform: "uppercase", color: C.on }}>Creator code</div>
            <div style={{ padding: "16px 36px", fontFamily: TEXT, fontWeight: 700, fontSize: 44, letterSpacing: "0.3em", paddingLeft: "calc(36px + 0.3em)", color: C.text }}>{code}</div>
          </div>
        )}
        {name && <div style={{ fontFamily: TEXT, fontWeight: 500, fontSize: 30, color: C.dim, letterSpacing: "0.1em", opacity: fade(88, 108) }}>Content Creator · <span style={{ color: C.text, fontWeight: 700 }}>{name}</span></div>}
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
