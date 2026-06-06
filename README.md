# Reel Maker

A browser-based tool for auto-editing videos and images into fast-cut 9:16 short-form reels. Runs entirely client-side — no server, no uploads. Exports H.264 MP4 with optional audio.

## Features

- **Auto timeline** — randomly assembles clips with sub-second cuts, variable playback speed (1.5–4×), and random horizontal crop placement
- **Cinematic effects** — film grain, vignette, light leaks, double exposure, flash cuts, film scratches
- **Color grading** — Auto, Blown Out, Cold & Gritty, Red Push, Desaturated
- **Ken Burns** — subtle zoom and pan on still images
- **Audio sync** — drop an audio track and the reel matches its duration exactly
- **End screen** — optional final image or video clip, rendered without effects
- **Effects bypass** — render raw cuts with no effects applied
- **Persistent sessions** — files and settings are saved in IndexedDB and restored on reload

## File naming conventions

| Prefix | Behavior |
|--------|----------|
| `glitch_` | Used only as ultra-short flash cuts and double-exposure overlays |
| `spare_` | Included in the main pool but capped at 3 uses per render |

## Quality

| Mode | Resolution | Bitrate |
|------|-----------|---------|
| 540p | 540×960 | 2.5 Mbps |
| 1080p | 1080×1920 | 8 Mbps |

The **▷ 8s** button renders a fast 270×480 preview (no end screen, no audio).

## Getting started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in a Chromium-based browser. WebCodecs (`VideoEncoder`, `AudioEncoder`) is required — Chrome/Edge 94+ or any recent Chromium build.

## How it works

The entire encode pipeline runs in the browser:

1. **Timeline** — `buildTimeline()` assembles clips with randomised start points, playback speeds, crop positions, and per-clip effects
2. **Render** — `renderReel()` seeks through each source video or image frame-by-frame on an offscreen canvas, applies effects, and feeds `VideoFrame` objects into a `VideoEncoder`
3. **Mux** — encoded chunks are passed to [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (loaded from CDN) to produce a self-contained MP4 `ArrayBuffer`
4. **Export** — the File System Access API (`showSaveFilePicker`) is used where available; falls back to an anchor download

## Tech

- React 19 + Vite
- WebCodecs API (VideoEncoder, AudioEncoder, VideoFrame)
- IndexedDB for file persistence
- mp4-muxer for MP4 muxing (CDN)
- No other runtime dependencies
