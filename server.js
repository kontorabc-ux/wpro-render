// WIADOMOŚCI PRO — mikroserwis renderujący (Express + Puppeteer)
// Renderuje szablony HTML do PNG (z alfą dla overlayów) po stronie serwera.
// Dzięki temu karty social i setki mogą powstawać AUTOMATYCZNIE przy publikacji artykułu.
//
// Endpointy:
//   GET /health
//   GET /social?format=post45&head=...&dzial=KRAJ&img=...&pilne=1   -> PNG karty social
//   GET /overlay?name=01_setka-lower-third&name=...&<paramy overlaya> -> PNG 1920x1080 z alfą
// Zabezpieczenie: jeśli ustawisz RENDER_TOKEN, wymagany jest &token=...
//
// ENV: PORT (domyślnie 8080), RENDER_TOKEN (opcjonalny), BASE_URL (skąd ładować szablony; domyślnie pliki lokalne)

import express from 'express';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { mountMontage } from './montage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;
const TOKEN = process.env.RENDER_TOKEN || '';

const SOCIAL_SIZES = {
  post45: [1080, 1350], square: [1080, 1080], story: [1080, 1920],
  thumb: [1280, 720], og: [1200, 630]
};

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
    });
  }
  return browserPromise;
}

// buduje file:// URL do szablonu z parametrami
function tplUrl(rel, params) {
  const u = pathToFileURL(path.join(__dirname, rel));
  const qs = new URLSearchParams(params).toString();
  return u.href + (qs ? '?' + qs : '');
}

function checkToken(req, res) {
  if (TOKEN && req.query.token !== TOKEN) { res.status(401).send('Brak/niepoprawny token'); return false; }
  return true;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'wpro-render', time: Date.now() }));

// KARTY SOCIAL
app.get('/social', async (req, res) => {
  if (!checkToken(req, res)) return;
  const format = req.query.format || 'post45';
  const [W, H] = SOCIAL_SIZES[format] || SOCIAL_SIZES.post45;
  const params = { format };
  for (const k of ['head', 'dzial', 'img', 'pilne', 'zrodlo']) if (req.query[k]) params[k] = req.query[k];
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
    await page.goto(tplUrl('social-card.html', params), { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const el = await page.$('#card');
    const buf = await (el || page).screenshot({ type: 'png' });
    await page.close();
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="WP_${format}.png"`);
    res.send(buf);
  } catch (e) { res.status(500).send('Render error: ' + e.message); }
});

// OVERLAYE BROADCAST (1920x1080, alfa)
app.get('/overlay', async (req, res) => {
  if (!checkToken(req, res)) return;
  const name = (req.query.name || '01_setka-lower-third').replace(/[^a-z0-9_\-]/gi, '');
  const params = {};
  for (const k of Object.keys(req.query)) if (!['name', 'token'].includes(k)) params[k] = req.query[k];
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(tplUrl(name + '.html', params), { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(600); // chwila na animację wejścia
    const buf = await page.screenshot({ type: 'png', omitBackground: true }); // alfa
    await page.close();
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="WP_${name}.png"`);
    res.send(buf);
  } catch (e) { res.status(500).send('Render error: ' + e.message); }
});

// OVERLAY WIDEO Z ALFĄ (MOV ProRes 4444 / WebM VP9) — do montażu
// GET /overlay-video?name=01_setka-lower-third&dur=3&fps=30&fmt=mov&<paramy overlaya>
app.get('/overlay-video', async (req, res) => {
  if (!checkToken(req, res)) return;
  const name = (req.query.name || '01_setka-lower-third').replace(/[^a-z0-9_\-]/gi, '');
  const dur = Math.min(Math.max(parseFloat(req.query.dur) || 3, 0.5), 10);
  const fmt = (req.query.fmt === 'webm') ? 'webm' : 'mov';
  const params = {};
  for (const k of Object.keys(req.query)) if (!['name', 'token', 'dur', 'fps', 'fmt'].includes(k)) params[k] = req.query[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpro-'));
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(tplUrl(name + '.html', params), { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    // klatki w czasie rzeczywistym (omitBackground = alfa)
    const start = Date.now(); let i = 0;
    while ((Date.now() - start) / 1000 < dur) {
      await page.screenshot({ path: path.join(dir, `f_${String(i).padStart(4, '0')}.png`), omitBackground: true });
      i++;
    }
    await page.close();
    const realFps = Math.max(1, Math.round(i / dur));
    const out = path.join(dir, 'out.' + fmt);
    const args = fmt === 'mov'
      ? ['-y', '-framerate', String(realFps), '-i', path.join(dir, 'f_%04d.png'), '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', out]
      : ['-y', '-framerate', String(realFps), '-i', path.join(dir, 'f_%04d.png'), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '4M', out];
    await new Promise((ok, no) => { const ff = spawn('ffmpeg', args); ff.on('close', c => c === 0 ? ok() : no(new Error('ffmpeg ' + c))); ff.on('error', no); });
    res.set('Content-Type', fmt === 'mov' ? 'video/quicktime' : 'video/webm');
    res.set('Content-Disposition', `attachment; filename="WP_${name}.${fmt}"`);
    res.send(fs.readFileSync(out));
  } catch (e) { res.status(500).send('Render error: ' + e.message); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

app.listen(PORT, () => console.log(`WPRO render-service na :${PORT}`));


// ── RENDER SERWEROWY MONTAZU (POST /montage) — dolozone 2026-07-15, additywnie
// Studio wysyla opis montazu (JSON), serwer sklada MP4 natywnym ffmpeg.
// Naprawia iPhone'a (Safari nie ma MediaRecorder/ctx.filter) i dlugie filmy.
app.use('/montage', express.json({ limit: '32mb' }));
mountMontage(app, { puppeteer, token: TOKEN });
