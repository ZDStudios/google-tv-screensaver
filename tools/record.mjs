// Renders index.html into a seamless looping 1080p30 video for TV sticks that can't run it live.
// Time is virtualised (rAF, timers, Date, performance.now, CSS/Web animations), so every frame is
// rendered exactly once no matter how slow the CI machine is. Output: out/loop.mp4 + out/meta.json
import puppeteer from 'puppeteer';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const LOOP = +(process.env.LOOP_SECONDS || 60);   // length of the final loop
const FADE = +(process.env.FADE_SECONDS || 2);    // crossfade used to hide the loop seam
const FPS = +(process.env.FPS || 30);
const WARMUP = +(process.env.WARMUP_SECONDS || 3);
const page_ = path.resolve(process.env.PAGE || 'index.html');
const out = path.resolve('out');
mkdirSync(out, { recursive: true });

const VIRTUAL_TIME = `(() => {
  let now = 0; const t0 = Date.now(); const OD = Date; const raf = []; let timers = []; let tid = 1;
  performance.now = () => now;
  function FakeDate(...a) { if (!(this instanceof FakeDate)) return new OD(t0 + now).toString(); return a.length ? new OD(...a) : new OD(t0 + now); }
  FakeDate.prototype = OD.prototype; FakeDate.now = () => t0 + now; FakeDate.UTC = OD.UTC; FakeDate.parse = OD.parse;
  window.Date = FakeDate;
  window.requestAnimationFrame = cb => { raf.push(cb); return raf.length; };
  window.cancelAnimationFrame = () => {};
  window.setTimeout = (f, d = 0, ...a) => { const id = tid++; timers.push({ id, t: now + (+d || 0), f: () => typeof f === 'function' ? f(...a) : eval(f) }); return id; };
  window.setInterval = (f, d = 0, ...a) => { const id = tid++; const iv = Math.max(1, +d || 0); timers.push({ id, t: now + iv, iv, f: () => typeof f === 'function' ? f(...a) : eval(f) }); return id; };
  window.clearTimeout = window.clearInterval = id => { timers = timers.filter(x => x.id !== id); };
  window.__advance = dt => {
    const target = now + dt;
    for (let guard = 0; guard < 10000; guard++) {
      timers.sort((a, b) => a.t - b.t); const x = timers[0];
      if (!x || x.t > target) break;
      now = x.t; if (x.iv) x.t += x.iv; else timers.shift();
      try { x.f(); } catch (e) { console.error(e); }
    }
    now = target;
    const q = raf.splice(0); for (const cb of q) { try { cb(now); } catch (e) { console.error(e); } }
    if (document.getAnimations) for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = now; } catch (e) {} }
    for (const v of document.querySelectorAll('video')) { try { v.pause(); if (v.duration) v.currentTime = (now / 1000) % v.duration; } catch (e) {} }
  };
})();`;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--disable-background-timer-throttling'],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 540, deviceScaleFactor: 2 });   // same CSS viewport as the TV
if (process.env.TIMEZONE) await page.emulateTimezone(process.env.TIMEZONE);   // e.g. Australia/Perth; runners are UTC
await page.evaluateOnNewDocument(VIRTUAL_TIME);
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(pathToFileURL(page_).href, { waitUntil: 'networkidle0', timeout: 60000 });

// The video carries only the canvas/WebGL scene; the TV overlays the page's live DOM (clocks,
// countdowns, text) on top of it, so hide everything else while recording.
if (process.env.HIDE_DOM !== '0') await page.addStyleTag({ content:
  'body *:not(canvas){visibility:hidden!important} canvas{visibility:visible!important}' });
const step = 1000 / FPS;
for (let i = 0; i < WARMUP * FPS; i++) await page.evaluate(d => window.__advance(d), step);

const raw = path.join(out, 'raw.mp4');
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', raw], { stdio: ['pipe', 'inherit', 'inherit'] });
const total = Math.round((LOOP + FADE) * FPS);
const started = Date.now();
for (let i = 0; i < total; i++) {
  await page.evaluate(d => window.__advance(d), step);
  const jpg = await page.screenshot({ type: 'jpeg', quality: 92, optimizeForSpeed: true });
  if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r));
  if (i % (FPS * 5) === 0) console.log(`frame ${i}/${total}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', c => c ? rej(new Error('ffmpeg ' + c)) : res()));
await browser.close();

// Seamless loop: the first FADE seconds crossfade from the tail (after LOOP) into the head.
const L = LOOP, F = FADE;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-filter_complex',
  `[0]split[a][b];[a]trim=start=${L}:end=${L + F},setpts=PTS-STARTPTS[tail];` +
  `[b]trim=start=0:end=${L},setpts=PTS-STARTPTS,split[m1][m2];` +
  `[m1]trim=start=0:end=${F},setpts=PTS-STARTPTS[head];[m2]trim=start=${F},setpts=PTS-STARTPTS[rest];` +
  `[tail][head]blend=all_expr='A*(1-T/${F})+B*(T/${F})'[x];[x][rest]concat=n=2:v=1:a=0,format=yuv420p[v]`,
  '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-profile:v', 'high', '-level', '4.1',
  '-movflags', '+faststart', path.join(out, 'loop.mp4')], { stdio: 'inherit' });

const html = readFileSync(page_);
const meta = {
  html_sha256: createHash('sha256').update(html).digest('hex'),
  commit: process.env.GITHUB_SHA || null,
  seconds: LOOP, fps: FPS, width: 1920, height: 1080,
  bytes: statSync(path.join(out, 'loop.mp4')).size,
  rendered_at: new Date().toISOString(),
};
writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
console.log('done', meta);
