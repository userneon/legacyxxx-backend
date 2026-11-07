import { Composition } from "remotion"

import { CodeBar, type CodeProps } from "./CodeBar"
import { CommunityBug, CommunityIntro, LogoSting, Wipe } from "./Community"
import { EndCard, type EndProps } from "./EndCard"
import { CodeGif, GlitchGif } from "./Gifs"
import { LowerThird, type NameProps } from "./LowerThird"

export const Root = () => (
  <>
    <Composition id="LowerThird" component={LowerThird} width={1920} height={1080} fps={30} durationInFrames={150} defaultProps={{ name: "Creator Name" } satisfies NameProps} />
    <Composition id="CodeBar" component={CodeBar} width={1920} height={1080} fps={30} durationInFrames={150} defaultProps={{ code: "K7M2QX" } satisfies CodeProps} />
    <Composition id="EndCard" component={EndCard} width={1920} height={1080} fps={30} durationInFrames={180} defaultProps={{ name: "Creator Name", code: "K7M2QX" } satisfies EndProps} />
    <Composition id="CodeGif" component={CodeGif} width={600} height={340} fps={20} durationInFrames={60} defaultProps={{ code: "K7M2QX" }} />
    <Composition id="GlitchGif" component={GlitchGif} width={600} height={340} fps={20} durationInFrames={60} defaultProps={{ name: "Creator Name" }} />
    <Composition id="CommunityIntro" component={CommunityIntro} width={1920} height={1080} fps={30} durationInFrames={150} />
    <Composition id="LogoSting" component={LogoSting} width={1920} height={1080} fps={30} durationInFrames={120} />
    <Composition id="Wipe" component={Wipe} width={1920} height={1080} fps={30} durationInFrames={36} />
    <Composition id="CommunityBug" component={CommunityBug} width={1920} height={1080} fps={30} durationInFrames={150} />
  </>
)
