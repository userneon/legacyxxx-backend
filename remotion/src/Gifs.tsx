import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion"

import { Backdrop } from "./Backdrop"
import { Wordmark } from "./Wordmark"
import { C, TEXT } from "./theme"

/** Looping stickers (GIF, 600 x 340, 60 frames at 20 fps). The loop is seamless: every motion is a whole turn of a sine or a sweep that ends where it began. */
const turn = (frame: number, frames = 60) => (frame / frames) * Math.PI * 2

/** "Use code K7M2QX": the code pulses, a light sweeps over the box, the border breathes. */
export const CodeGif = ({ code }: { code: string }) => {
  const frame = useCurrentFrame()
  const breath = 0.5 + 0.5 * Math.sin(turn(frame))
  const sweep = interpolate(frame, [0, 60], [-40, 140])
  return (
    <AbsoluteFill>
      <Backdrop shift={breath * 8} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 22 }}>
        <div style={{ fontFamily: TEXT, fontWeight: 500, fontSize: 24, color: C.dim, letterSpacing: "0.34em", textTransform: "uppercase" }}>Use creator code</div>
        <div style={{ position: "relative", overflow: "hidden", padding: "14px 40px 14px calc(40px + 0.28em)", border: `2px solid rgba(167,139,250,${0.45 + breath * 0.45})`, background: "rgba(10,10,10,.85)", boxShadow: `0 0 ${20 + breath * 30}px rgba(139,92,246,${0.25 + breath * 0.3})`, fontFamily: TEXT, fontWeight: 700, fontSize: 72, letterSpacing: "0.28em", color: C.text, transform: `scale(${1 + breath * 0.03})` }}>
          {code}
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${sweep}%`, width: 90, background: "linear-gradient(100deg, transparent, rgba(255,255,255,.28), transparent)", transform: "skewX(-20deg)" }} />
        </div>
        <Wordmark size={30} />
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

/** The wordmark with a short glitch (a split of the colours and a slip) that comes and goes, with the creator's name under it. */
export const GlitchGif = ({ name }: { name: string }) => {
  const frame = useCurrentFrame()
  const burst = frame % 30 >= 24 && frame % 30 <= 27 ? 1 : 0
  const slip = burst ? ((frame * 37) % 17) - 8 : 0
  return (
    <AbsoluteFill>
      <Backdrop shift={0} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 24 }}>
        <div style={{ position: "relative" }}>
          {burst ? <div style={{ position: "absolute", left: -slip - 4, top: 0, opacity: 0.8, mixBlendMode: "screen" }}><Wordmark size={92} style={{ color: C.brand }} /></div> : null}
          {burst ? <div style={{ position: "absolute", left: slip + 4, top: 0, opacity: 0.8, mixBlendMode: "screen" }}><Wordmark size={92} style={{ color: "#fafafa" }} /></div> : null}
          <div style={{ transform: `translateX(${slip}px)` }}><Wordmark size={92} /></div>
        </div>
        {name && <div style={{ fontFamily: TEXT, fontWeight: 500, fontSize: 28, color: C.dim, letterSpacing: "0.14em", textTransform: "uppercase" }}>Content Creator · <span style={{ color: C.text, fontWeight: 700 }}>{name}</span></div>}
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
