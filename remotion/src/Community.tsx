import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"

import { Mark } from "./Mark"
import { Wordmark } from "./Wordmark"
import { C, TEXT } from "./theme"

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const
const glow = "drop-shadow(0 0 18px rgba(139,92,246,.55))"

/** A line whose letters come in one after another from below, each with a small spring. */
const Letters = ({ text, start, step, size, spacing, color, weight = 700 }: { text: string; start: number; step: number; size: number; spacing: string; color: string; weight?: number }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <div style={{ display: "flex", fontFamily: TEXT, fontWeight: weight, fontSize: size, lineHeight: 1, color, letterSpacing: spacing, whiteSpace: "pre", filter: glow }}>
      {text.split("").map((ch, index) => {
        const t = spring({ frame: frame - start - index * step, fps, config: { damping: 15, stiffness: 150 }, durationInFrames: 22 })
        return <span key={index} style={{ display: "inline-block", opacity: Math.min(1, t * 1.6), transform: `translateY(${(1 - t) * 46}px)` }}>{ch}</span>
      })}
    </div>
  )
}

/**
 * The community title (owner request 2026-11-07): the "L" of the mark builds up, then "COUNTER-STRIKE" and "COMMUNITY" come in letter by letter, one line after the other,
 * hold, and everything leaves. Transparent. 150 frames at 30 fps.
 */
export const CommunityIntro = () => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const stem = interpolate(frame, [0, 16], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) })
  const base = interpolate(frame, [8, 26], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) })
  const rule = interpolate(frame, [58, 84], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) })
  const out = interpolate(frame, [durationInFrames - 26, durationInFrames - 4], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) })
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 64, transform: `translateX(${-out * 120}px)`, opacity: 1 - out }}>
        <Mark size={330} stem={stem} base={base} style={{ filter: glow }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Letters text="COUNTER-STRIKE" start={28} step={2} size={104} spacing="0.1em" color={C.text} />
          <div style={{ height: 4, width: `${rule * 100}%`, background: `linear-gradient(90deg, ${C.brand}, ${C.bright})`, boxShadow: "0 0 20px rgba(139,92,246,.7)" }} />
          <Letters text="COMMUNITY" start={56} step={3} size={70} spacing="0.42em" color={C.bright} weight={500} />
        </div>
      </div>
    </AbsoluteFill>
  )
}

/** The mark builds up, the wordmark wipes out from behind it. Transparent. 120 frames at 30 fps. */
export const LogoSting = () => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const stem = interpolate(frame, [0, 14], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) })
  const base = interpolate(frame, [6, 22], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) })
  const wipe = interpolate(frame, [20, 46], [0, 100], { ...clamp, easing: Easing.out(Easing.cubic) })
  const out = interpolate(frame, [durationInFrames - 22, durationInFrames - 4], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) })
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 48, opacity: 1 - out, transform: `scale(${1 + out * 0.06})` }}>
        <Mark size={260} stem={stem} base={base} style={{ filter: glow }} />
        <div style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)`, filter: glow }}><Wordmark size={190} /></div>
      </div>
    </AbsoluteFill>
  )
}

/** A screen wipe between two clips: violet panels sweep across at an angle, cover the picture for a moment and sweep off. Transparent. 36 frames at 30 fps. */
export const Wipe = () => {
  const frame = useCurrentFrame()
  const panel = (delay: number, color: string, index: number) => {
    const t = interpolate(frame, [delay, delay + 20], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) })
    const x = interpolate(t, [0, 0.5, 1], [-2400, 0, 2400])
    return <div key={index} style={{ position: "absolute", top: -300, bottom: -300, left: -300 + index * 0, width: 3400, background: color, transform: `translateX(${x}px) skewX(-18deg)` }} />
  }
  const logo = interpolate(frame, [12, 18, 22, 26], [0, 1, 1, 0], clamp)
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {panel(0, C.brand, 0)}
      {panel(3, "#0a0a0a", 1)}
      {panel(6, C.bright, 2)}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: logo }}><Mark size={260} /></AbsoluteFill>
    </AbsoluteFill>
  )
}

/** A corner badge that slides in from the right, holds with a light running over it, and leaves. Transparent. 150 frames at 30 fps. */
export const CommunityBug = () => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 17, stiffness: 110 }, durationInFrames: 26 })
  const leave = interpolate(frame, [durationInFrames - 24, durationInFrames - 4], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) })
  const x = interpolate(enter, [0, 1], [700, 0]) + leave * 700
  const sweep = interpolate(frame, [50, 80], [-30, 130], clamp)
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", right: 64, top: 56, display: "flex", alignItems: "center", gap: 20, padding: "14px 30px 14px 22px", background: "rgba(10,10,10,.86)", border: "1px solid rgba(255,255,255,.16)", transform: `translateX(${x}px)`, overflow: "hidden" }}>
        <Mark size={62} stem={1} base={1} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontFamily: TEXT, fontWeight: 700, fontSize: 28, letterSpacing: "0.12em", color: C.text, lineHeight: 1 }}>COUNTER-STRIKE</div>
          <div style={{ fontFamily: TEXT, fontWeight: 500, fontSize: 20, letterSpacing: "0.4em", color: C.bright, lineHeight: 1 }}>COMMUNITY</div>
        </div>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${sweep}%`, width: 90, background: "linear-gradient(100deg, transparent, rgba(255,255,255,.2), transparent)", transform: "skewX(-20deg)" }} />
      </div>
    </AbsoluteFill>
  )
}
