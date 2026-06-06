import { useRef, useState, useCallback, useEffect } from "react";

const DEFAULT_SETTINGS = {
  grainAmount: 0.5,
  lightLeakFreq: 0.5,
  doubleExposureChance: 0.5,
  flashCutChance: 0.5,
  colorGrade: "auto",
  bypassEffects: false,
};

const COLOR_GRADE_LABELS = {
  auto: "Auto",
  blown_out: "Blown Out",
  cold_gritty: "Cold & Gritty",
  red_push: "Red Push",
  desaturated: "Desaturated",
};

const GRADE_SPECS = {
  blown_out:   { filter: "contrast(1.5) saturate(0.45) brightness(1.45)", tint: null },
  cold_gritty: { filter: "contrast(1.6) saturate(0.35) brightness(0.72)", tint: { color: "#1a2e5a", opacity: 0.22 } },
  red_push:    { filter: "contrast(1.3) saturate(1.55) brightness(0.88)", tint: { color: "#7a1000", opacity: 0.14 } },
  desaturated: { filter: "contrast(1.75) saturate(0.07) brightness(0.82)", tint: null },
};

const LIGHT_LEAK_COLORS = ["#ff5500", "#ff2200", "#ffaa00", "#cc2200", "#ff7700"];
const PRESETS = ["auto", "blown_out", "cold_gritty", "red_push", "desaturated"];
const PREVIEW_SECS = 8;
const FPS = 30;
const END_SCREEN_SECS = 3;
const EMPTY_EFFECTS = { grain: 0, vignette: 0, lightLeak: null, doubleExposure: null, colorFilter: "none", colorTint: null, flashCut: false, scratches: false };
const SPARE_CAP = 3;

function isSpare(item) { return item.file?.name.toLowerCase().startsWith("spare_"); }

function fmt(s) {
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60)   return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${s.toFixed(1)}s`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fileIsVideo(f) { return f.type.startsWith("video/"); }
function fileIsImage(f) { return f.type.startsWith("image/"); }
function fileIsAudio(f) { return f.type.startsWith("audio/") || f.name.toLowerCase().endsWith(".wav"); }
function isGlitch(name) { return name.toLowerCase().startsWith("glitch_"); }

async function getAudioDuration(file) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();
  return decoded.duration;
}

async function loadMediaItem(file) {
  const url = URL.createObjectURL(file);
  const id = crypto.randomUUID();
  const glitch = isGlitch(file.name);
  if (fileIsVideo(file)) {
    const video = document.createElement("video");
    video.src = url; video.muted = true; video.preload = "metadata";
    await new Promise(r => { video.onloadedmetadata = r; video.onerror = r; setTimeout(r, 5000); });
    return { id, type: "video", file, url, duration: video.duration, element: video, glitch };
  } else {
    const img = new Image();
    img.src = url;
    await new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 3000); });
    return { id, type: "image", file, url, element: img, glitch };
  }
}

// ── Timeline ──────────────────────────────────────────────────────────────────
function randomClipDuration(allowLong) {
  if (allowLong) return 1.5 + Math.random() * 0.5;
  return Math.random() < 0.55 ? 0.4 + Math.random() * 0.5 : 0.9 + Math.random() * 0.4;
}

function randomPlaybackSpeed() {
  return 1.5 + Math.random() * 2.5;  // 1.5–4× sped up
}

function biasedCropX() {
  const r = Math.random();
  if (r < 0.4) return Math.random() * 0.3;        // left zone  0–0.3
  if (r < 0.8) return 0.7 + Math.random() * 0.3;  // right zone 0.7–1
  return 0.25 + Math.random() * 0.5;               // center zone
}

function pickCropX(id, seen) {
  let cx, attempts = 0;
  do { cx = biasedCropX(); attempts++; }
  while (attempts < 8 && seen.has(id) && Math.abs(cx - seen.get(id)) < 0.25);
  seen.set(id, cx);
  return cx;
}

function randomEffects(allItems, current, s) {
  const others = allItems.filter(i => i !== current);
  const glitchSources = others.filter(i => i.glitch);
  const nonGlitchSources = others.filter(i => !i.glitch);
  const doublePool = (glitchSources.length > 0 && Math.random() < 1 / 3)
    ? glitchSources
    : (nonGlitchSources.length > 0 ? nonGlitchSources : glitchSources);
  const doubleSource = Math.random() < s.doubleExposureChance * 0.35 && doublePool.length > 0
    ? doublePool[Math.floor(Math.random() * doublePool.length)] : null;

  let colorFilter, colorTint = null;
  if (s.colorGrade === "auto") {
    colorFilter = `contrast(${(1.1 + Math.random() * 0.35).toFixed(2)}) saturate(${(0.65 + Math.random() * 0.5).toFixed(2)}) brightness(${(0.82 + Math.random() * 0.22).toFixed(2)})`;
  } else {
    colorFilter = GRADE_SPECS[s.colorGrade].filter;
    colorTint = GRADE_SPECS[s.colorGrade].tint;
  }

  const grainBase = 0.05 + s.grainAmount * 0.2;
  return {
    grain: grainBase + Math.random() * grainBase,
    vignette: 0.3 + Math.random() * 0.4,
    lightLeak: Math.random() < s.lightLeakFreq * 0.6
      ? { x: Math.random(), y: Math.random() < 0.5 ? 0 : 1, color: LIGHT_LEAK_COLORS[Math.floor(Math.random() * LIGHT_LEAK_COLORS.length)] } : null,
    doubleExposure: doubleSource
      ? { source: doubleSource.element, opacity: 0.22 + Math.random() * 0.2, _item: doubleSource } : null,
    colorFilter, colorTint,
    flashCut: Math.random() < s.flashCutChance * 0.35,
    scratches: Math.random() < 0.12,
  };
}

function buildTimeline(items, targetDuration, settings, endScreen) {
  const endDur = endScreen
    ? (endScreen.type === "video" ? (endScreen.duration || END_SCREEN_SECS) : END_SCREEN_SECS)
    : 0;
  const mainDuration = targetDuration - endDur;
  const endClip = endScreen
    ? { item: endScreen, startTime: 0, duration: endDur, effects: EMPTY_EFFECTS, kenBurns: { zoom: 0, panX: 0, panY: 0 } }
    : null;
  const lastCropX = new Map();
  const spareUsage = new Map();

  if (!items.length) return endClip ? [endClip] : [];
  const normalItems = items.filter(i => !i.glitch);
  const glitchItems = items.filter(i => i.glitch);
  const mainPool = normalItems.length > 0 ? normalItems : items;

  // Single video: loop it cleanly for the full duration, no cuts
  if (mainPool.length === 1 && mainPool[0].type === "video") {
    const item = mainPool[0];
    const vidDur = item.duration || mainDuration;
    const fx = { ...randomEffects(items, item, settings), flashCut: false };
    const clips = [];
    let filled = 0;
    while (filled < mainDuration - 0.1) {
      const dur = Math.min(vidDur, mainDuration - filled);
      if (dur < 0.1) break;
      const raw = randomPlaybackSpeed();
      const maxSpeed = vidDur > 0.1 ? (vidDur - 0.1) / dur : 1;
      const speed = Math.min(raw, maxSpeed);
      const videoNeeded = dur * speed;
      const available = vidDur - videoNeeded - 0.1;
      const startTime = available > 0 ? Math.random() * available : 0;
      clips.push({ item, startTime, duration: dur, speed, effects: fx, kenBurns: { zoom: 0, panX: 0, panY: 0, cropX: pickCropX(item.id, lastCropX) } });
      filled += dur;
    }
    if (endClip) clips.push(endClip);
    return clips;
  }

  const clips = [];
  let totalTime = 0;
  const pool = [...mainPool].sort(() => Math.random() - 0.5);
  let idx = 0, longBudget = 2;

  while (totalTime < mainDuration - 0.25) {
    const remaining = mainDuration - totalTime;

    // Occasionally inject a glitch clip as a very quick flash
    if (glitchItems.length > 0 && clips.length > 0 && Math.random() < 0.03) {
      const g = glitchItems[Math.floor(Math.random() * glitchItems.length)];
      const dur = Math.min(0.1 + Math.random() * 0.15, remaining);
      if (dur >= 0.08) {
        let startTime = 0;
        if (g.type === "video" && g.duration > 0 && isFinite(g.duration)) {
          const avail = g.duration - dur - 0.1;
          if (avail > 0) startTime = Math.random() * avail;
        }
        clips.push({ item: g, startTime, duration: dur, effects: { ...randomEffects(items, g, settings), flashCut: true }, kenBurns: { zoom: 1, panX: 0, panY: 0, cropX: pickCropX(g.id, lastCropX) } });
        totalTime += dur;
        continue;
      }
    }

    let item = pool[idx % pool.length]; idx++;
    // Spare cap: skip past capped items, trying up to pool.length alternatives
    for (let t = 0; t < pool.length && isSpare(item) && (spareUsage.get(item.id) || 0) >= SPARE_CAP; t++) {
      item = pool[idx % pool.length]; idx++;
    }
    if (isSpare(item) && (spareUsage.get(item.id) || 0) >= SPARE_CAP) break;
    if (isSpare(item)) spareUsage.set(item.id, (spareUsage.get(item.id) || 0) + 1);

    const wantLong = longBudget > 0 && Math.random() < 0.15;
    if (wantLong) longBudget--;
    const dur = Math.min(randomClipDuration(wantLong), Math.min(2.0, remaining));
    if (dur < 0.25) break;

    let startTime = 0, speed = 1;
    if (item.type === "video" && item.duration > 0 && isFinite(item.duration)) {
      const raw = randomPlaybackSpeed();
      const maxSpeed = (item.duration - 0.1) / dur;
      speed = Math.min(raw, maxSpeed);
      const available = item.duration - (dur * speed) - 0.1;
      if (available > 0) startTime = Math.random() * available;
    }

    clips.push({
      item, startTime, duration: dur, speed,
      effects: randomEffects(items, item, settings),
      kenBurns: { zoom: Math.random() < 0.5 ? 1 : -1, panX: (Math.random() - 0.5) * 2, panY: (Math.random() - 0.5) * 2, cropX: pickCropX(item.id, lastCropX) },
    });
    totalTime += dur;
    if (idx % pool.length === 0) pool.sort(() => Math.random() - 0.5);
  }
  if (endClip) clips.push(endClip);
  return clips;
}

// ── Effects ───────────────────────────────────────────────────────────────────
let _grainCanvas = null, _grainCtx = null, _lastGrainUpdate = 0;
function getGrainCtx() {
  if (!_grainCanvas) { _grainCanvas = document.createElement("canvas"); _grainCanvas.width = 512; _grainCanvas.height = 512; _grainCtx = _grainCanvas.getContext("2d"); }
  return [_grainCanvas, _grainCtx];
}
function refreshGrain(intensity) {
  const now = performance.now();
  if (now - _lastGrainUpdate < 66) return;
  _lastGrainUpdate = now;
  const [, gCtx] = getGrainCtx();
  const imgData = gCtx.createImageData(512, 512);
  for (let i = 0; i < imgData.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    imgData.data[i] = v; imgData.data[i+1] = v; imgData.data[i+2] = v; imgData.data[i+3] = (intensity * 200) | 0;
  }
  gCtx.putImageData(imgData, 0, 0);
}

let _scratchCanvas = null, _lastScratchUpdate = 0;
function getScratchFrame(w, h) {
  if (!_scratchCanvas) _scratchCanvas = document.createElement("canvas");
  _scratchCanvas.width = w; _scratchCanvas.height = h;
  if (performance.now() - _lastScratchUpdate < 120) return _scratchCanvas;
  _lastScratchUpdate = performance.now();
  const sCtx = _scratchCanvas.getContext("2d");
  sCtx.clearRect(0, 0, w, h);
  sCtx.strokeStyle = "rgba(255,255,255,0.22)";
  for (let i = 0; i < Math.floor(Math.random() * 3) + 1; i++) {
    const x = Math.random() * w;
    sCtx.lineWidth = 0.5 + Math.random();
    sCtx.beginPath(); sCtx.moveTo(x, 0); sCtx.lineTo(x + (Math.random() - 0.5) * 10, h); sCtx.stroke();
  }
  return _scratchCanvas;
}

function applyEffects(ctx, w, h, effects) {
  if (effects.colorTint) {
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = effects.colorTint.opacity;
    ctx.fillStyle = effects.colorTint.color; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = 1;
  }
  if (effects.vignette > 0) {
    const cx = w/2, cy = h/2, r = Math.sqrt(cx*cx + cy*cy);
    const grad = ctx.createRadialGradient(cx, cy, r*0.4, cx, cy, r);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, `rgba(0,0,0,${effects.vignette.toFixed(2)})`);
    ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  }
  if (effects.lightLeak) {
    const lx = effects.lightLeak.x * w, ly = effects.lightLeak.y * h, r = Math.max(w, h) * 0.75;
    const grad = ctx.createRadialGradient(lx, ly, 0, lx, ly, r);
    grad.addColorStop(0, effects.lightLeak.color + "55"); grad.addColorStop(0.3, effects.lightLeak.color + "22"); grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalCompositeOperation = "screen"; ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h); ctx.globalCompositeOperation = "source-over";
  }
  if (effects.doubleExposure?.source) {
    ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = effects.doubleExposure.opacity;
    try { ctx.drawImage(effects.doubleExposure.source, 0, 0, w, h); } catch {}
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  }
  if (effects.scratches) { ctx.drawImage(getScratchFrame(w, h), 0, 0); }
  if (effects.grain > 0) {
    refreshGrain(effects.grain);
    const [gc] = getGrainCtx();
    ctx.globalCompositeOperation = "overlay"; ctx.globalAlpha = 0.65;
    for (let x = 0; x < w; x += 512) for (let y = 0; y < h; y += 512) ctx.drawImage(gc, x, y);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  }
}

// ── drawCover ─────────────────────────────────────────────────────────────────
function drawCover(ctx, source, w, h, kb) {
  let srcW, srcH;
  if (source instanceof ImageBitmap) { srcW = source.width; srcH = source.height; }
  else if (source instanceof HTMLVideoElement) { srcW = source.videoWidth || w; srcH = source.videoHeight || h; }
  else { srcW = source.naturalWidth || w; srcH = source.naturalHeight || h; }
  const scale = Math.max(w / srcW, h / srcH);
  let dw = srcW * scale, dh = srcH * scale;
  if (kb?.zoom) { const z = 1 + Math.abs(kb.zoom) * 0.02 * (kb.progress ?? 0); dw *= z; dh *= z; }
  const dx = (w - dw) * (kb?.cropX ?? 0.5) + (kb?.panX ? kb.panX * (kb.progress ?? 0) * 5 : 0);
  const dy = (h - dh) / 2 + (kb?.panY ? kb.panY * (kb.progress ?? 0) * 3 : 0);
  ctx.drawImage(source, dx, dy, dw, dh);
}

// ── waitForSeek ───────────────────────────────────────────────────────────────
function waitForSeek(video) {
  return new Promise(resolve => {
    video.addEventListener("seeked", resolve, { once: true });
    setTimeout(resolve, 800);
  });
}

// ── renderReel ────────────────────────────────────────────────────────────────
let _mp4muxer = null;
async function loadMp4Muxer() {
  if (_mp4muxer) return _mp4muxer;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.js";
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  if (typeof Mp4Muxer === "undefined") throw new Error("mp4-muxer not loaded");
  _mp4muxer = Mp4Muxer;
  return _mp4muxer;
}

function chooseAvcLevelHex(w, h) {
  const mbF = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbS = mbF * FPS;
  let lvl;
  if (mbS <= 108000 && mbF <= 3600) lvl = 0x1f;       // 3.1  (≤720p30)
  else if (mbS <= 245760 && mbF <= 8192) lvl = 0x28;  // 4.0  (≤1080p30)
  else if (mbS <= 522240 && mbF <= 8704) lvl = 0x2a;  // 4.2
  else lvl = 0x33;                                    // 5.1
  return lvl.toString(16).padStart(2, "0");
}

async function pickVideoCodec(w, h, bitrate) {
  const lvlHex = chooseAvcLevelHex(w, h);
  // Baseline first: no B-frames, so PTS==DTS — matches our linear timestamps and is the most
  // widely decodable in the <video> element. Fall back to Main, then High.
  const candidates = ["avc1.4200" + lvlHex, "avc1.4d00" + lvlHex, "avc1.6400" + lvlHex];
  for (const codec of candidates) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: FPS };
    try {
      if (typeof VideoEncoder !== "undefined" && VideoEncoder.isConfigSupported) {
        const sup = await VideoEncoder.isConfigSupported(cfg);
        if (sup && sup.supported) return codec;
      } else {
        return codec;
      }
    } catch {}
  }
  return candidates[0];
}

async function renderReel(clips, w, h, onProgress, onLog, audioFile, hardCapMs, bitrate, bypassEffects) {
  bitrate = bitrate || 8_000_000;
  onLog("Loading encoder…");
  const { Muxer, ArrayBufferTarget } = await loadMp4Muxer();
  onLog("Encoder ready");

  const target = new ArrayBufferTarget();

  // ── Prepare audio BEFORE building the muxer ──────────────────────────────────
  // If decode/resample fails we must NOT declare an audio track, or the file ends up
  // with an empty track that the <video> element rejects (MEDIA_ERR_SRC_NOT_SUPPORTED).
  const AUDIO_RATE = 48000;
  let pcmL = null, pcmR = null, totalAudioSamples = 0, audioOk = false;
  if (audioFile) {
    try {
      const tmpCtx = new AudioContext();
      const audioBuf = await tmpCtx.decodeAudioData(await audioFile.arrayBuffer());
      tmpCtx.close();
      const durationS = hardCapMs ? hardCapMs / 1000 : clips.reduce((s, c) => s + c.duration, 0);
      totalAudioSamples = Math.floor(Math.min(audioBuf.duration, durationS) * AUDIO_RATE);
      if (audioBuf.sampleRate !== AUDIO_RATE) {
        const offCtx = new OfflineAudioContext(2, Math.ceil(audioBuf.duration * AUDIO_RATE), AUDIO_RATE);
        const src = offCtx.createBufferSource(); src.buffer = audioBuf; src.connect(offCtx.destination); src.start();
        const rendered = await offCtx.startRendering();
        pcmL = rendered.getChannelData(0);
        pcmR = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : pcmL;
      } else {
        pcmL = audioBuf.getChannelData(0);
        pcmR = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : pcmL;
      }
      audioOk = totalAudioSamples > 0;
    } catch (e) { onLog("Audio prep failed (continuing silent): " + e.message); audioOk = false; }
  }

  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: w, height: h },
    audio: audioOk ? { codec: "aac", sampleRate: AUDIO_RATE, numberOfChannels: 2 } : undefined,
    fastStart: "in-memory",
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => onLog("VideoEncoder error: " + e.message),
  });
  const videoCodec = await pickVideoCodec(w, h, bitrate);
  onLog("Codec " + videoCodec);
  // avc.format:"avc" → length-prefixed AVCC + a decoderConfig.description the muxer needs.
  videoEncoder.configure({ codec: videoCodec, width: w, height: h, bitrate, framerate: FPS, avc: { format: "avc" } });

  // ── Encode the prepared audio ────────────────────────────────────────────────
  if (audioOk) {
    try {
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: e => onLog("AudioEncoder error: " + e.message),
      });
      audioEncoder.configure({ codec: "mp4a.40.2", sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 128_000 });
      const CHUNK = 4096;
      for (let offset = 0; offset < totalAudioSamples; offset += CHUNK) {
        const len = Math.min(CHUNK, totalAudioSamples - offset);
        const buf = new Float32Array(len * 2);
        buf.set(pcmL.subarray(offset, offset + len), 0);
        buf.set(pcmR.subarray(offset, offset + len), len);
        const ab = new AudioData({ format: "f32-planar", sampleRate: AUDIO_RATE, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(offset / AUDIO_RATE * 1_000_000), data: buf });
        audioEncoder.encode(ab); ab.close();
      }
      await audioEncoder.flush();
      onLog("Audio encoded");
    } catch (e) { onLog("Audio encode failed: " + e.message); }
  }

  // Fresh source cache
  const imgCache = new Map();
  const vidCache = new Map();

  async function freshImg(item) {
    if (imgCache.has(item.id)) return imgCache.get(item.id);
    const bmp = await createImageBitmap(item.file);
    imgCache.set(item.id, bmp);
    return bmp;
  }
  async function freshVid(item) {
    if (vidCache.has(item.id)) return vidCache.get(item.id);
    const vid = document.createElement("video");
    vid.src = item.url; vid.muted = true; vid.preload = "auto";
    await new Promise(r => { vid.onloadedmetadata = r; vid.onerror = r; setTimeout(r, 5000); });
    vidCache.set(item.id, vid);
    return vid;
  }

  // Build allItems pool for double-exposure fallback
  const allItems = [...new Map(clips.map(c => [c.item.id, c.item])).values()];

  const offscreen = document.createElement("canvas");
  offscreen.width = w; offscreen.height = h;
  const ctx = offscreen.getContext("2d");

  const totalFrames = clips.reduce((s, c) => s + Math.ceil(c.duration * FPS), 0);
  let framesDone = 0, timestamp = 0;

  for (let ci = 0; ci < clips.length; ci++) {
    const clip = clips[ci];
    onLog((ci + 1) + "/" + clips.length + " · " + clip.item.type + " · " + clip.duration.toFixed(2) + "s");

    // Resolve double-exposure source freshly
    let fx = clip.effects;
    if (fx.doubleExposure) {
      const deItem = fx.doubleExposure._item || allItems.find(i => i.element === fx.doubleExposure.source);
      if (deItem) {
        const src = deItem.type === "image" ? await freshImg(deItem) : await freshVid(deItem);
        fx = { ...fx, doubleExposure: { ...fx.doubleExposure, source: src } };
      } else {
        fx = { ...fx, doubleExposure: null };
      }
    }

    const clipFrames = Math.ceil(clip.duration * FPS);
    const frameDur = Math.round(1_000_000 / FPS);

    // Flash cut frame
    if (fx.flashCut && ci > 0 && !bypassEffects) {
      ctx.fillStyle = Math.random() < 0.5 ? "#fff" : "#000";
      ctx.fillRect(0, 0, w, h);
      const bmp = await createImageBitmap(offscreen);
      const vf = new VideoFrame(bmp, { timestamp, duration: frameDur });
      videoEncoder.encode(vf, { keyFrame: false }); vf.close(); bmp.close();
      timestamp += frameDur; framesDone++;
    }

    if (clip.item.type === "video") {
      const vid = await freshVid(clip.item);
      const speed = clip.speed ?? 1;
      for (let f = 0; f < clipFrames; f++) {
        vid.currentTime = clip.startTime + (f / FPS) * speed;
        await waitForSeek(vid);
        if (!bypassEffects) ctx.filter = fx.colorFilter;
        drawCover(ctx, vid, w, h, { cropX: clip.kenBurns?.cropX ?? 0.5 });
        ctx.filter = "none";
        if (!bypassEffects) applyEffects(ctx, w, h, fx);
        const bmp = await createImageBitmap(offscreen);
        const vf = new VideoFrame(bmp, { timestamp, duration: frameDur });
        videoEncoder.encode(vf, { keyFrame: f % (FPS * 2) === 0 }); vf.close(); bmp.close();
        timestamp += frameDur; framesDone++;
        onProgress(framesDone / totalFrames);
      }
    } else {
      const img = await freshImg(clip.item);
      for (let f = 0; f < clipFrames; f++) {
        const progress = f / clipFrames;
        if (!bypassEffects) ctx.filter = fx.colorFilter;
        drawCover(ctx, img, w, h, { ...clip.kenBurns, progress });
        ctx.filter = "none";
        if (!bypassEffects) applyEffects(ctx, w, h, fx);
        const bmp = await createImageBitmap(offscreen);
        const vf = new VideoFrame(bmp, { timestamp, duration: frameDur });
        videoEncoder.encode(vf, { keyFrame: f % (FPS * 2) === 0 }); vf.close(); bmp.close();
        timestamp += frameDur; framesDone++;
        onProgress(framesDone / totalFrames);
      }
    }
  }

  onLog("Finalizing…");
  await videoEncoder.flush();
  muxer.finalize();
  for (const bmp of imgCache.values()) bmp.close();

  const { buffer } = target;
  onLog("Done · " + (buffer.byteLength / 1_000_000).toFixed(1) + " MB");
  return new Blob([buffer], { type: "video/mp4" });
}

// ── Storage helpers ───────────────────────────────────────────────────────────
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, val) {
  try { localStorage.setItem(key, val); } catch {}
}

// ── IndexedDB file store ──────────────────────────────────────────────────────
const DB_NAME = "reel-maker-files";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains("files"))
        e.target.result.createObjectStore("files", { keyPath: "id" });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(record);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}
async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readonly");
    const req = tx.objectStore("files").getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Slider({ label, hint, value, onChange, disabled }) {
  const pct = Math.round(value * 100);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      <div style={{ display:"flex", justifyContent:"space-between" }}>
        <span style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.12em", color:"rgba(255,255,255,0.45)" }}>{label}</span>
        <span style={{ fontSize:9, fontFamily:"monospace", color:"rgba(255,255,255,0.28)" }}>{pct}%</span>
      </div>
      <input type="range" min={0} max={100} value={pct} disabled={disabled}
        onChange={e => onChange(Number(e.target.value) / 100)}
        style={{ width:"100%", accentColor:"#e63030", opacity: disabled ? 0.3 : 1 }} />
      <span style={{ fontSize:9, color:"rgba(255,255,255,0.2)" }}>{hint}</span>
    </div>
  );
}

function PresetGrid({ value, onChange, disabled }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      <span style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", color:"rgba(255,255,255,0.28)" }}>Color Grade</span>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
        {PRESETS.map(p => (
          <button key={p} disabled={disabled} onClick={() => onChange(p)}
            style={{ padding:"8px", fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", borderRadius:2, border:"none",
              cursor: disabled ? "not-allowed" : "pointer", textAlign:"left", lineHeight:1.2, transition:"all 0.15s",
              background: value === p ? "#e63030" : "rgba(255,255,255,0.06)",
              color: value === p ? "white" : "rgba(255,255,255,0.4)", opacity: disabled ? 0.3 : 1 }}>
            {COLOR_GRADE_LABELS[p]}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function ReelMaker() {
  const [items, setItems]               = useState([]);
  const [audioFile, setAudioFile]       = useState(null);
  const [audioDuration, setAudioDuration] = useState(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [status, setStatus]             = useState("idle");
  const [progress, setProgress]         = useState(0);
  const [logs, setLogs]                 = useState([]);
  const [downloadUrl, setDownloadUrl]   = useState(null); // blob: object URL — for download anchor
  const [previewSrc, setPreviewSrc]     = useState(null); // data: URL — for inline <video> (blob: is blocked by sandbox)
  const [playerOk, setPlayerOk]         = useState(true);  // false if the sandbox CSP rejects the media URL
  const [downloadBlob, setDownloadBlob] = useState(null); // raw Blob
  const [mediaDragging, setMediaDragging] = useState(false);
  const [audioDragging, setAudioDragging] = useState(false);
  const [endScreenItem, setEndScreenItem] = useState(null);
  const [endScreenDragging, setEndScreenDragging] = useState(false);
  const [settings, setSettings]         = useState(DEFAULT_SETTINGS);
  const [quality, setQuality]           = useState("high");
  const [isPreview, setIsPreview]       = useState(false);

  const mediaInput     = useRef(null);
  const audioInput     = useRef(null);
  const endScreenInput = useRef(null);
  const logsEnd        = useRef(null);
  const objUrlRef      = useRef(null);

  useEffect(() => {
    (async () => {
      const s = storageGet("reel:settings");
      const q = storageGet("reel:quality");
      if (s) { try { setSettings(prev => ({ ...prev, ...JSON.parse(s) })); } catch {} }
      if (q) setQuality(q === "low" ? "low" : "high");
      try {
        const records = await dbGetAll();
        const mediaRecords = records.filter(r => !r.isAudio && !r.isEndScreen).sort((a, b) => (a.created || 0) - (b.created || 0));
        const audioRecord = records.find(r => r.isAudio);
        const endScreenRecord = records.find(r => r.isEndScreen);
        if (mediaRecords.length > 0) {
          const loaded = await Promise.all(mediaRecords.map(async r => {
            const file = new File([r.blob], r.name, { type: r.mimeType });
            return loadMediaItem(file).catch(() => null);
          }));
          setItems(loaded.filter(Boolean));
        }
        if (audioRecord) {
          const file = new File([audioRecord.blob], audioRecord.name, { type: audioRecord.mimeType });
          try { const dur = await getAudioDuration(file); setAudioFile(file); setAudioDuration(dur); } catch {}
        }
        if (endScreenRecord) {
          const file = new File([endScreenRecord.blob], endScreenRecord.name, { type: endScreenRecord.mimeType });
          loadMediaItem(file).then(item => setEndScreenItem(item)).catch(() => {});
        }
      } catch (e) { console.error("File restore failed:", e); }
    })();
  }, []); // eslint-disable-line

  const persistTimer = useRef(null);
  useEffect(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      storageSet("reel:settings", JSON.stringify(settings));
      storageSet("reel:quality", quality);
    }, 700);
    return () => clearTimeout(persistTimer.current);
  }, [settings, quality]);

  useEffect(() => { logsEnd.current?.scrollIntoView({ behavior:"smooth" }); }, [logs]);
  useEffect(() => () => { if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current); }, []);

  const addLog = useCallback(msg => setLogs(p => [...p.slice(-60), msg]), []);
  const setSetting = useCallback(key => val => setSettings(p => ({ ...p, [key]: val })), []);

  const handleMediaFiles = useCallback(async files => {
    const valid = files.filter(f => fileIsVideo(f) || fileIsImage(f));
    if (!valid.length) return;
    setStatus("loading"); addLog("Loading " + valid.length + " file(s)…");
    try {
      const loaded = await Promise.all(valid.map(loadMediaItem));
      setItems(prev => {
        const ex = new Set(prev.map(i => i.file.name));
        const newItems = loaded.filter(l => !ex.has(l.file.name));
        newItems.forEach((item, i) =>
          dbPut({ id: item.id, name: item.file.name, mimeType: item.file.type, blob: item.file, glitch: item.glitch, isAudio: false, created: Date.now() + i }).catch(console.error)
        );
        return [...prev, ...newItems];
      });
      addLog(loaded.length + " file(s) ready");
    } catch(e) { addLog("Error: " + e.message); }
    finally { setStatus("idle"); }
  }, [addLog]);

  const handleAudioFile = useCallback(async file => {
    if (!fileIsAudio(file)) return;
    setAudioLoading(true); addLog("Loading audio: " + file.name);
    try {
      const dur = await getAudioDuration(file);
      setAudioFile(file); setAudioDuration(dur);
      addLog("Audio ready · " + fmt(dur));
      dbPut({ id: "audio", name: file.name, mimeType: file.type, blob: file, isAudio: true }).catch(console.error);
    }
    catch(e) { addLog("Audio error: " + e.message); }
    finally { setAudioLoading(false); }
  }, [addLog]);

  const removeItem = useCallback(id => {
    setItems(prev => { const it = prev.find(i => i.id === id); if (it) URL.revokeObjectURL(it.url); return prev.filter(i => i.id !== id); });
    dbDelete(id).catch(console.error);
  }, []);

  const clearAllMedia = useCallback(() => {
    setItems(prev => { prev.forEach(i => URL.revokeObjectURL(i.url)); return []; });
    dbGetAll().then(records =>
      records.filter(r => !r.isAudio && !r.isEndScreen).forEach(r => dbDelete(r.id).catch(console.error))
    ).catch(console.error);
  }, []);

  const handleEndScreenFile = useCallback(async file => {
    if (!fileIsVideo(file) && !fileIsImage(file)) return;
    try {
      const item = await loadMediaItem(file);
      setEndScreenItem(prev => { if (prev) URL.revokeObjectURL(prev.url); return item; });
      dbPut({ id: "endscreen", name: file.name, mimeType: file.type, blob: file, isEndScreen: true }).catch(console.error);
    } catch(e) { addLog("End screen error: " + e.message); }
  }, [addLog]);

  const removeEndScreen = useCallback(() => {
    setEndScreenItem(prev => { if (prev) URL.revokeObjectURL(prev.url); return null; });
    dbDelete("endscreen").catch(console.error);
  }, []);

  const runRender = useCallback(async (preview) => {
    if (!items.length) return;
    const isHigh = quality === "high" && !preview;
    const w = preview ? 270 : (isHigh ? 1080 : 540);
    const h = preview ? 480 : (isHigh ? 1920 : 960);
    const dur = preview ? PREVIEW_SECS : (audioDuration ?? 30);
    const br  = preview ? 800_000 : (isHigh ? 8_000_000 : 2_500_000);

    if (objUrlRef.current) { URL.revokeObjectURL(objUrlRef.current); objUrlRef.current = null; }
    setIsPreview(preview); setStatus("rendering"); setProgress(0); setLogs([]); setDownloadUrl(null); setPreviewSrc(null); setPlayerOk(true); setDownloadBlob(null);
    addLog(w + "x" + h + " · " + fmt(dur) + (preview ? " · preview" : ""));

    const glitchCount = items.filter(i => i.glitch).length;
    if (glitchCount) addLog(glitchCount + " glitch file(s) → flash/double-exposure only");
    const clips = buildTimeline(items, dur, settings, preview ? null : endScreenItem);
    addLog(clips.length + " clips · avg " + (clips.reduce((s,c) => s+c.duration,0) / clips.length).toFixed(2) + "s");

    try {
      const blob = await renderReel(clips, w, h, p => setProgress(Math.round(p*100)), addLog, preview ? null : audioFile, preview ? undefined : (audioDuration ? audioDuration * 1000 : undefined), br, settings.bypassEffects);
      // Download path first — this is the guaranteed one and must not depend on the preview.
      const url = URL.createObjectURL(blob);
      objUrlRef.current = url;
      setDownloadBlob(blob);
      setDownloadUrl(url);
      setStatus("done");

      // Inline preview is best-effort only: the sandbox may block the media URL, and the
      // data-URL conversion can fail on large files. Either way, never break the download.
      try {
        const dataUrl = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = () => rej(new Error("preview read failed"));
          reader.readAsDataURL(blob);
        });
        setPreviewSrc(dataUrl);
      } catch (e) {
        addLog("Inline preview unavailable: " + e.message);
        setPlayerOk(false);
      }
    } catch(e) {
      setStatus("error"); addLog("Render failed: " + e.message);
    }
  }, [items, settings, quality, audioDuration, audioFile, endScreenItem, addLog]);

  const isRendering = status === "rendering";
  const isLoading   = status === "loading" || audioLoading;
  const busy        = isRendering || isLoading;
  const canAct      = items.length > 0 && !busy;
  const totalSrc    = items.reduce((s,i) => s + (i.duration ?? 0), 0);

  const C = {
    root:    { minHeight:"100vh", background:"#0c0c0c", color:"#e8e8e8", display:"flex", flexDirection:"column", fontFamily:"system-ui,sans-serif" },
    header:  { padding:"28px 32px 20px", borderBottom:"1px solid rgba(255,255,255,0.08)" },
    main:    { flex:1, display:"flex", flexWrap:"wrap", overflow:"hidden" },
    left:    { flex:1, display:"flex", flexDirection:"column", padding:28, gap:20, minWidth:280, overflowY:"auto" },
    effects: { width:240, borderLeft:"1px solid rgba(255,255,255,0.08)", display:"flex", flexDirection:"column" },
    log:     { width:200, borderLeft:"1px solid rgba(255,255,255,0.08)", display:"flex", flexDirection:"column" },
    phdr:    { padding:"16px 20px", borderBottom:"1px solid rgba(255,255,255,0.08)", fontSize:10, textTransform:"uppercase", letterSpacing:"0.12em", color:"rgba(255,255,255,0.28)" },
    pbody:   { flex:1, overflowY:"auto", padding:20 },
  };

  return (
    <div style={C.root}>
      <header style={C.header}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:"white" }}>Reel Maker</h1>
        <p style={{ margin:"4px 0 0", fontSize:11, color:"rgba(255,255,255,0.3)", letterSpacing:"0.1em" }}>
          1080×1920 · fast cuts · rock treatment{audioDuration ? " · " + fmt(audioDuration) + " with audio" : " · 30s"}
        </p>
      </header>

      <main style={C.main}>
        <div style={{ flex:1, display:"flex", flexDirection:"column", minWidth:280, overflow:"hidden" }}>
        <div style={C.left}>

          {/* Media drop zone */}
          <div
            onDrop={e => { e.preventDefault(); setMediaDragging(false); const fs = Array.from(e.dataTransfer.files); const a = fs.find(fileIsAudio); if (a) handleAudioFile(a); handleMediaFiles(fs); }}
            onDragOver={e => { e.preventDefault(); setMediaDragging(true); }}
            onDragLeave={() => setMediaDragging(false)}
            onClick={() => mediaInput.current?.click()}
            style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10, cursor:"pointer", border:"2px dashed", borderRadius:2, minHeight:130, padding:20, textAlign:"center", transition:"all 0.15s", userSelect:"none",
              borderColor: mediaDragging ? "#e63030" : "rgba(255,255,255,0.16)", background: mediaDragging ? "rgba(230,48,48,0.08)" : "rgba(255,255,255,0.02)",
              opacity: busy ? 0.4 : 1, pointerEvents: busy ? "none" : "auto" }}>
            <input ref={mediaInput} type="file" multiple accept="video/*,image/*" style={{ display:"none" }}
              onChange={e => { if (e.target.files) { handleMediaFiles(Array.from(e.target.files)); e.target.value=""; } }} />
            <div style={{ fontSize:28, opacity:0.22 }}>⊕</div>
            <div style={{ fontSize:13, color:"rgba(255,255,255,0.42)", letterSpacing:"0.08em" }}>Drop videos &amp; images</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.22)" }}>MP4 · MOV · WEBM · JPG · PNG</div>
          </div>

          {/* Audio drop zone */}
          <div
            onDrop={e => { e.preventDefault(); setAudioDragging(false); const f = Array.from(e.dataTransfer.files).find(fileIsAudio); if (f) handleAudioFile(f); }}
            onDragOver={e => { e.preventDefault(); setAudioDragging(true); }}
            onDragLeave={() => setAudioDragging(false)}
            onClick={() => audioInput.current?.click()}
            style={{ display:"flex", alignItems:"center", gap:16, padding:"0 16px", cursor:"pointer", border:"1px dashed", borderRadius:2, minHeight:52, transition:"all 0.15s", userSelect:"none",
              borderColor: audioDragging ? "rgba(245,158,11,0.6)" : audioFile ? "rgba(245,158,11,0.3)" : "rgba(255,255,255,0.12)",
              background: audioFile ? "rgba(245,158,11,0.04)" : "rgba(255,255,255,0.01)",
              opacity: busy ? 0.4 : 1, pointerEvents: busy ? "none" : "auto" }}>
            <input ref={audioInput} type="file" accept="audio/*,.wav,.mp3,.aac,.flac" style={{ display:"none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) { handleAudioFile(f); e.target.value=""; } }} />
            <div style={{ fontSize:18, opacity:0.38 }}>♪</div>
            <div style={{ flex:1, minWidth:0 }}>
              {audioFile ? (
                <><div style={{ fontSize:11, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis", color:"rgba(251,191,36,0.8)" }}>{audioFile.name}</div>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,0.3)", marginTop:2 }}>{audioDuration ? fmt(audioDuration) + " · will match video length" : "…"}</div></>
              ) : (
                <><div style={{ fontSize:11, color:"rgba(255,255,255,0.38)" }}>Drop audio track (optional)</div>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,0.2)" }}>WAV · MP3 · AAC</div></>
              )}
            </div>
            {audioFile && <button onClick={e => { e.stopPropagation(); setAudioFile(null); setAudioDuration(null); dbDelete("audio").catch(console.error); }} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.28)", cursor:"pointer", fontSize:20 }}>×</button>}
          </div>

          {/* End screen drop zone */}
          <div
            onDrop={e => { e.preventDefault(); setEndScreenDragging(false); const f = Array.from(e.dataTransfer.files).find(f => fileIsVideo(f) || fileIsImage(f)); if (f) handleEndScreenFile(f); }}
            onDragOver={e => { e.preventDefault(); setEndScreenDragging(true); }}
            onDragLeave={() => setEndScreenDragging(false)}
            onClick={() => endScreenInput.current?.click()}
            style={{ display:"flex", alignItems:"center", gap:16, padding:"0 16px", cursor:"pointer", border:"1px dashed", borderRadius:2, minHeight:52, transition:"all 0.15s", userSelect:"none",
              borderColor: endScreenDragging ? "rgba(139,92,246,0.6)" : endScreenItem ? "rgba(139,92,246,0.3)" : "rgba(255,255,255,0.12)",
              background: endScreenItem ? "rgba(139,92,246,0.04)" : "rgba(255,255,255,0.01)",
              opacity: busy ? 0.4 : 1, pointerEvents: busy ? "none" : "auto" }}>
            <input ref={endScreenInput} type="file" accept="video/*,image/*" style={{ display:"none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) { handleEndScreenFile(f); e.target.value=""; } }} />
            <div style={{ fontSize:18, opacity:0.38 }}>⊡</div>
            <div style={{ flex:1, minWidth:0 }}>
              {endScreenItem ? (
                <><div style={{ fontSize:11, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis", color:"rgba(139,92,246,0.85)" }}>{endScreenItem.file.name}</div>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,0.3)", marginTop:2 }}>
                    {endScreenItem.type === "video" ? fmt(endScreenItem.duration ?? 0) : END_SCREEN_SECS + "s"} · end screen · no effects
                  </div></>
              ) : (
                <><div style={{ fontSize:11, color:"rgba(255,255,255,0.38)" }}>End screen (optional)</div>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,0.2)" }}>Last frame · image or video · no effects applied</div></>
              )}
            </div>
            {endScreenItem && <button onClick={e => { e.stopPropagation(); removeEndScreen(); }} disabled={busy} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.28)", cursor:"pointer", fontSize:20 }}>×</button>}
          </div>

          {/* File list */}
          {items.length > 0 && (
            <div>
              <div style={{ fontSize:10, color:"rgba(255,255,255,0.26)", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:4, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span>{items.length} file{items.length !== 1 ? "s" : ""}{totalSrc > 0 && " · " + fmt(totalSrc) + " source"}</span>
                <button onClick={clearAllMedia} disabled={busy} style={{ background:"none", border:"none", fontSize:9, textTransform:"uppercase", letterSpacing:"0.1em", color:"rgba(255,255,255,0.25)", cursor:"pointer", padding:0, opacity: busy ? 0.2 : 1 }}>Clear all</button>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:160, overflowY:"auto" }}>
                {items.map(item => (
                  <div key={item.id} style={{ display:"flex", alignItems:"center", gap:12, background:"rgba(255,255,255,0.04)", padding:"8px 12px", borderRadius:2 }}>
                    <div style={{ width:32, height:32, flexShrink:0, background:"rgba(255,255,255,0.08)", borderRadius:2, overflow:"hidden" }}>
                      {item.type === "image" ? <img src={item.url} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} /> : <video src={item.url} style={{ width:"100%", height:"100%", objectFit:"cover" }} muted />}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:11, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis", color: item.glitch ? "rgba(168,85,247,0.9)" : isSpare(item) ? "rgba(255,200,100,0.85)" : "rgba(255,255,255,0.7)" }}>{item.file.name}</div>
                      <div style={{ fontSize:9, color:"rgba(255,255,255,0.28)", marginTop:2 }}>
                        {item.glitch
                          ? <span style={{ color:"rgba(168,85,247,0.6)" }}>glitch · flash/double-exposure only</span>
                          : isSpare(item)
                          ? <span style={{ color:"rgba(255,200,100,0.5)" }}>spare · max {SPARE_CAP}× · {item.type === "video" ? "video · " + fmt(item.duration ?? 0) : "image"}</span>
                          : item.type === "video" ? "video · " + fmt(item.duration ?? 0) : "image"}
                      </div>
                    </div>
                    <button onClick={() => removeItem(item.id)} disabled={busy} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.3)", cursor:"pointer", fontSize:18, opacity: busy ? 0.2 : 1 }}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quality toggle */}
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", color:"rgba(255,255,255,0.28)", flexShrink:0 }}>Quality</span>
            {["low","high"].map(q => (
              <button key={q} onClick={() => setQuality(q)} disabled={busy}
                style={{ padding:"5px 12px", fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", borderRadius:2, border:"none", cursor: busy ? "not-allowed" : "pointer", transition:"all 0.15s", opacity: busy ? 0.4 : 1,
                  background: quality === q ? (q === "low" ? "rgba(251,191,36,0.18)" : "#e63030") : "rgba(255,255,255,0.06)",
                  color: quality === q ? (q === "low" ? "rgba(251,191,36,0.9)" : "white") : "rgba(255,255,255,0.35)" }}>
                {q === "low" ? "540p" : "1080p"}
              </button>
            ))}
            <span style={{ fontSize:9, color:"rgba(255,255,255,0.18)" }}>{quality === "low" ? "540×960 · fast" : "1080×1920 · final"}</span>
          </div>

          {/* Buttons */}
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => runRender(true)} disabled={!canAct}
              style={{ flexShrink:0, padding:"12px 16px", fontSize:11, fontWeight:"bold", textTransform:"uppercase", letterSpacing:"0.1em", borderRadius:2, border:"none", transition:"all 0.15s",
                cursor: canAct ? "pointer" : "not-allowed", background:"rgba(255,255,255,0.1)", color:"rgba(255,255,255,0.6)", opacity: canAct ? 1 : 0.3 }}>
              {isRendering && isPreview ? "▷ " + progress + "%" : "▷ " + PREVIEW_SECS + "s"}
            </button>
            <button onClick={() => runRender(false)} disabled={!canAct || (isRendering && isPreview === false)}
              style={{ flex:1, padding:"12px 0", fontSize:13, fontWeight:"bold", textTransform:"uppercase", letterSpacing:"0.1em", borderRadius:2, border:"none", transition:"all 0.15s",
                cursor: canAct ? "pointer" : "not-allowed",
                background: canAct && !(isRendering && !isPreview) ? "#e63030" : "rgba(255,255,255,0.05)",
                color: canAct && !(isRendering && !isPreview) ? "white" : "rgba(255,255,255,0.18)" }}>
              {isRendering && !isPreview ? "Rendering… " + progress + "%" : isLoading ? "Loading…" : audioDuration ? "Generate · " + fmt(audioDuration) : "Generate · " + (quality === "low" ? "540p" : "1080p")}
            </button>
          </div>

          {isRendering && (
            <div style={{ width:"100%", height:2, background:"rgba(255,255,255,0.08)", borderRadius:999, overflow:"hidden" }}>
              <div style={{ height:"100%", background:"#e63030", width: progress + "%", transition:"width 0.3s" }} />
            </div>
          )}

          {/* Result */}
          {status === "done" && downloadUrl && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {isPreview && <div style={{ fontSize:9, textTransform:"uppercase", letterSpacing:"0.1em", color:"rgba(255,255,255,0.25)", textAlign:"center" }}>preview · 270×480 · 8s</div>}
              {playerOk && previewSrc ? (
                <video
                  key={previewSrc}
                  src={previewSrc}
                  controls loop playsInline preload="auto"
                  onError={e => {
                    const err = e.currentTarget.error;
                    addLog("Player error" + (err ? " · code " + err.code : "") + (err && err.message ? " · " + err.message : ""));
                    setPlayerOk(false);
                  }}
                  style={{ borderRadius:2, background:"black", margin:"0 auto", display:"block", maxHeight:340, aspectRatio:"9/16", width:"100%" }} />
              ) : (
                <div style={{ borderRadius:2, border:"1px dashed rgba(255,255,255,0.16)", padding:"24px 16px", textAlign:"center", fontSize:11, lineHeight:1.6, color:"rgba(255,255,255,0.5)" }}>
                  Inline preview is blocked by this sandbox's media policy.<br />
                  Your <strong style={{ color:"rgba(255,255,255,0.75)" }}>.mp4 is ready</strong> — download below to view it.
                </div>
              )}
              <button onClick={async () => {
                if (!downloadBlob) return;
                // Primary: File System Access API writes straight to disk and does NOT route
                // the file through the artifact host's (rate-limited) postMessage bridge.
                if (window.showSaveFilePicker) {
                  try {
                    const handle = await window.showSaveFilePicker({
                      suggestedName: `reel-${Date.now()}.mp4`,
                      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(downloadBlob);
                    await writable.close();
                    addLog("Saved to disk");
                    return;
                  } catch (e) {
                    if (e && e.name === "AbortError") return; // user cancelled the picker
                    addLog("Save picker unavailable here: " + (e && e.message));
                  }
                }
                // Fallback: anchor download. In this sandbox the host proxies the whole file
                // over a rate-limited bridge, so large videos may fail with a rate-limit error.
                try {
                  const a = document.createElement('a');
                  a.href = downloadUrl;
                  a.download = `reel-${Date.now()}.mp4`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                } catch {
                  addLog("Download blocked by sandbox — open this component outside the artifact preview");
                }
              }}
                style={{ display:"block", width:"100%", padding:"12px 0", textAlign:"center", fontSize:13, fontWeight:"bold", textTransform:"uppercase", letterSpacing:"0.1em", borderRadius:2, background:"white", color:"black", border:"none", cursor:"pointer" }}>
                Save .mp4
              </button>
              <button onClick={() => runRender(false)} disabled={busy}
                style={{ width:"100%", padding:"12px 0", fontSize:13, fontWeight:"bold", textTransform:"uppercase", letterSpacing:"0.1em", borderRadius:2, border:"1px solid rgba(255,255,255,0.16)", background:"none", color:"rgba(255,255,255,0.45)", cursor:"pointer", opacity: busy ? 0.3 : 1 }}>
                Re-generate (new random cut)
              </button>
            </div>
          )}

          {status === "error" && (
            <div style={{ fontSize:11, color:"rgb(248,113,113)", border:"1px solid rgba(127,29,29,0.4)", borderRadius:2, padding:"8px 12px", background:"rgba(69,10,10,0.2)" }}>
              Render failed — see log →
            </div>
          )}
        </div>

        {/* Effects panel */}
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.08)", display:"flex", flexDirection:"column" }}>
          <div style={{ ...C.phdr, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <span>Effects</span>
            <button onClick={() => setSetting("bypassEffects")(!settings.bypassEffects)} disabled={busy}
              style={{ fontSize:9, textTransform:"uppercase", letterSpacing:"0.1em", padding:"3px 10px", borderRadius:2, border:"1px solid", fontFamily:"inherit",
                cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.3 : 1,
                borderColor: settings.bypassEffects ? "rgba(255,255,255,0.2)" : "rgba(230,48,48,0.35)",
                background: settings.bypassEffects ? "rgba(255,255,255,0.06)" : "rgba(230,48,48,0.08)",
                color: settings.bypassEffects ? "rgba(255,255,255,0.45)" : "rgba(230,48,48,0.75)" }}>
              {settings.bypassEffects ? "bypassed" : "active"}
            </button>
          </div>
          <div style={{ ...C.pbody, display:"flex", flexDirection:"row", flexWrap:"wrap", gap:24, alignItems:"flex-start",
            opacity: settings.bypassEffects ? 0.3 : 1, pointerEvents: settings.bypassEffects ? "none" : "auto" }}>
            <PresetGrid value={settings.colorGrade} onChange={setSetting("colorGrade")} disabled={busy} />
            <div style={{ width:1, background:"rgba(255,255,255,0.08)", alignSelf:"stretch", flexShrink:0 }} />
            <div style={{ flex:1, minWidth:280, display:"grid", gridTemplateColumns:"1fr 1fr", gap:"20px 32px" }}>
              <Slider label="Film Grain"      hint="Noise and texture per clip"     value={settings.grainAmount}          onChange={setSetting("grainAmount")}          disabled={busy} />
              <Slider label="Light Leaks"     hint="Warm flare frequency"           value={settings.lightLeakFreq}        onChange={setSetting("lightLeakFreq")}        disabled={busy} />
              <Slider label="Double Exposure" hint="Chance of blending two sources" value={settings.doubleExposureChance} onChange={setSetting("doubleExposureChance")} disabled={busy} />
              <Slider label="Flash Cuts"      hint="Flash frame at transitions"     value={settings.flashCutChance}       onChange={setSetting("flashCutChance")}       disabled={busy} />
            </div>
            <button onClick={() => setSettings(DEFAULT_SETTINGS)} disabled={busy}
              style={{ background:"none", border:"none", fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", color:"rgba(255,255,255,0.22)", cursor:"pointer", opacity: busy ? 0.25 : 1, alignSelf:"flex-end" }}>
              Reset to defaults
            </button>
          </div>
        </div>
        </div>

        {/* Log panel */}
        <div style={C.log}>
          <div style={C.phdr}>Log</div>
          <div style={{ ...C.pbody, fontFamily:"monospace", fontSize:10, lineHeight:1.6, color:"rgba(255,255,255,0.3)" }}>
            {logs.length === 0 ? <span style={{ color:"rgba(255,255,255,0.16)" }}>Nothing yet…</span>
              : logs.map((l, i) => <div key={i} style={{ marginBottom:2 }}><span style={{ color:"rgba(255,255,255,0.16)" }}>&gt; </span>{l}</div>)}
            <div ref={logsEnd} />
          </div>
        </div>
      </main>
    </div>
  );
}
