# Creator kit animations (Remotion)

Compositions in `src/`: `LowerThird` and `CodeBar` (slide in from the side, transparent WebM), `EndCard` (MP4), `CodeGif` and `GlitchGif` (looping GIFs).
The API renders them with a creator's name and code (`server/legacyX/kitRender.ts`); by hand:

    npm ci
    node render.mjs LowerThird out.webm '{"name":"Mongol Pro"}'
    npx remotion studio src/index.ts      # preview and edit

Fonts (Black Ops One, Exo 2) come from Google Fonts at render time. A render of 150 frames at 1080p takes about 20-35 s on 2 cores.
