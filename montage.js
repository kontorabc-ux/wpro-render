/* ══════════════════════════════════════════════════════════════════════════
   WIADOMOŚCI PRO — RENDER SERWEROWY MONTAŻU  (POST /montage)
   ─────────────────────────────────────────────────────────────────────────
   Studio wysyła OPIS montażu (ten sam model danych co MONT w studio.php),
   serwer składa film natywnym ffmpeg — szybciej niż realtime, bez limitów
   przeglądarki. To naprawia iPhone/Safari (brak MediaRecorder/ctx.filter)
   i długie filmy (10-30+ min).

   Endpointy (montowane additywnie w server.js — nic istniejącego nie rusza):
     POST /montage            → {id, status:'queued'}   (zwraca NATYCHMIAST)
     GET  /montage/:id        → {status, progress, url, error, log}
     GET  /montage/:id/file   → gotowy MP4
     DELETE /montage/:id      → sprząta pliki

   Render jest ASYNCHRONICZNY (kolejka 1 zadanie naraz) — długi render nie
   może wisieć na jednym połączeniu HTTP (proxy Render.com zrywa je),
   a 512 MB RAM planu Free nie zniesie dwóch ffmpegów jednocześnie.
   ══════════════════════════════════════════════════════════════════════════ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── Ustawienia ─────────────────────────────────────────────────────────── */
const ROOT       = path.join(os.tmpdir(), 'wpro-montage');
const RATIO_DIMS = { '169':[1920,1080], '916':[1080,1920], '45':[1080,1350], '11':[1080,1080] };
const FPS        = 25;
const FADE_D     = 0.4;                       // ta sama wartość co w edytorze (fd=0.4)
const MAX_BYTES  = 1200 * 1024 * 1024;        // łączny limit pobieranych plików
const MAX_CLIPS  = 200;
const JOB_TTL_MS = 60 * 60 * 1000;            // gotowy plik żyje godzinę
const PRESET     = process.env.FF_PRESET || 'veryfast';
const CRF        = process.env.FF_CRF || '21';
/* WĄTKI x264 — NAJWAŻNIEJSZA POKRĘTKA PAMIĘCI (lekcja z 15.07).
   Kontener na Render widzi rdzenie HOSTA, więc x264 sam z siebie odpala
   ~1,5×rdzenie wątków i każdy bierze własne bufory klatek: zmierzone
   1080p veryfast = 320-430 MB → instancja 512 MB ginie („Ran out of memory"),
   i to BEZ żadnego Chromium. Przy threads=2 ten sam render mieści się
   w ~245 MB (pełny łańcuch z dekodowaniem ~320 MB). */
const THREADS    = process.env.FF_THREADS || '2';
const X264 = () => ['-threads', THREADS, '-x264-params',
  'threads=' + THREADS + ':lookahead-threads=1:sliced-threads=0'];

/* ── „UTNIJ FILM DO NARRACJI" (dodane 16.07.2026) ─────────────────────────
   Problem z LIVE: długość filmu = SUMA długości klipów (patrz `total` w runJob),
   więc gdy obraz jest dłuższy niż mowa (np. nagranie prezentera, gdzie kamera
   nagrywa dalej po ostatnim zdaniu), na końcu zostaje CICHY OGON. Zmierzone na
   realnym pliku: 50,1 s obrazu / 30,2 s dźwięku, mowa kończy się na 29,3 s.
   Ta poprawka wykrywa realny koniec narracji i przycina do niego OBRAZ.
   Sterowanie: FIT_TO_AUDIO=0 wyłącza (domyślnie WŁĄCZONE). Nigdy nie wydłuża
   filmu i nigdy nie tnie mowy (pad + minimum + próg oszczędności). */
const FIT_TO_AUDIO = process.env.FIT_TO_AUDIO !== '0';
const FIT_MIN_FILM = Number(process.env.FIT_MIN_FILM || 3);    // nie tnij poniżej [s]
const FIT_PAD      = Number(process.env.FIT_PAD || 0.6);       // oddech po ostatnim słowie [s]
const FIT_MIN_GAIN = Number(process.env.FIT_MIN_GAIN || 1.0);  // tnij tylko, gdy urwiemy > tyle [s]
const FIT_SIL_DB   = process.env.FIT_SIL_DB || '-40dB';        // próg ciszy
const FIT_SIL_MIN  = Number(process.env.FIT_SIL_MIN || 0.6);   // min. długość ciszy [s]

const jobs = new Map();
let queue = Promise.resolve();

/* ── Narzędzia ──────────────────────────────────────────────────────────── */
const nz  = (v, d) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

function ffmpeg(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args]);
    let err = '';
    const feed = buf => {
      const s = buf.toString();
      err = (err + s).slice(-4000);
      if (onLine) s.split(/\r?\n/).forEach(onLine);
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ':\n' + err)));
  });
}

function ffprobe(file) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries',
      'stream=width,height,codec_type,duration:format=duration', '-of', 'json', file]);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve({ streams: [], format: {} }); } });
    p.on('error', () => resolve({ streams: [], format: {} }));
  });
}

async function probeInfo(file) {
  const j = await ffprobe(file);
  const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  return {
    w: nz(v.width, 0), h: nz(v.height, 0), hasAudio: !!a,
    dur: nz(j.format && j.format.duration, 0) || nz(v.duration, 0)
  };
}

/* Pobranie pliku po URL — tylko http(s), z limitem rozmiaru.
   STRUMIENIOWO na dysk: `arrayBuffer()` wciągnąłby 300 MB rolki z iPhone'a
   do RAM-u i zabił instancję (512 MB). Piszemy kawałek po kawałku. */
async function download(url, dest, budget) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Dozwolone są tylko publiczne URL-e http(s): ' + url);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('Nie udało się pobrać ' + url + ' (HTTP ' + r.status + ')');
  const len = Number(r.headers.get('content-length') || 0);
  if (len && len > budget.left) throw new Error('Przekroczony limit rozmiaru materiałów (' + Math.round(MAX_BYTES / 1048576) + ' MB)');
  const out = fs.createWriteStream(dest);
  let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > budget.left) { out.destroy(); try { await reader.cancel(); } catch {} throw new Error('Przekroczony limit rozmiaru materiałów'); }
    if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
  }
  await new Promise((res, rej) => { out.end(err => err ? rej(err) : res()); });
  budget.left -= got;
  return dest;
}

/* ══════════════════════════════════════════════════════════════════════════
   CSS filter → ffmpeg
   Edytor trzyma efekty jako łańcuchy CSS (FX w studio-text.js: 'grayscale(80%)
   contrast(120%)' itd.). Zamiast dublować tabelę efektów (i rozjeżdżać się
   z podglądem), TŁUMACZYMY ten sam łańcuch na filtry ffmpeg. Dzięki temu
   dołożenie efektu w edytorze nie wymaga zmian na serwerze.
   ══════════════════════════════════════════════════════════════════════════ */
function cssFilterToFfmpeg(css) {
  if (!css || css === 'none') return [];
  const out = [];
  const re = /([a-z-]+)\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(css))) {
    const fn = m[1].toLowerCase();
    const raw = m[2].trim();
    const num = parseFloat(raw) || 0;
    const pct = /%$/.test(raw) ? num / 100 : num;      // 80% → 0.8
    switch (fn) {
      // CSS blur(radius) ≈ gauss o sigma = radius/2
      case 'blur':        if (num > 0) out.push('gblur=sigma=' + (num / 2).toFixed(3)); break;
      // grayscale(p) = odbarwienie w p%
      case 'grayscale':   out.push('hue=s=' + Math.max(0, 1 - pct).toFixed(3)); break;
      case 'saturate':    out.push('eq=saturation=' + pct.toFixed(3)); break;
      // CSS brightness/contrast są MNOŻĄCE na RGB — colorchannelmixer odwzorowuje 1:1
      case 'brightness':  out.push('colorchannelmixer=rr=' + pct.toFixed(3) + ':gg=' + pct.toFixed(3) + ':bb=' + pct.toFixed(3)); break;
      case 'contrast':    out.push('eq=contrast=' + pct.toFixed(3)); break;
      case 'hue-rotate':  out.push('hue=h=' + num.toFixed(2)); break;
      case 'invert':      if (pct > 0) out.push(lutInvert(pct)); break;
      case 'sepia':       if (pct > 0) out.push(sepiaMix(pct)); break;
      case 'opacity':     break;                        // nieużywane na klipie
      default: break;                                   // nieznane → pomiń, nie wywalaj renderu
    }
  }
  return out;
}

// CSS invert(p): out = val*(1-2p) + 255p
function lutInvert(p) {
  const a = (1 - 2 * p).toFixed(4), b = (255 * p).toFixed(2);
  const e = "'val*" + a + "+" + b + "'";
  return 'lutrgb=r=' + e + ':g=' + e + ':b=' + e;
}

// CSS sepia(p): interpolacja macierzy tożsamościowej → sepia
function sepiaMix(p) {
  const S = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const k = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
  const v = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v.push((I[i][j] * (1 - p) + S[i][j] * p).toFixed(4));
  return 'colorchannelmixer=' + k.map((n, i) => n + '=' + v[i]).join(':');
}

/* Efekty rysowane PO obrazie (FX .p w edytorze: winieta, ziarno, lustro…) */
function postFxFilters(effect, fx) {
  const k = nz(fx, 60) / 100;
  switch (effect) {
    case 'vignette': return ['vignette=angle=' + (Math.PI / 4 * (0.6 + k)).toFixed(3)];
    case 'grain':    return ['noise=alls=' + Math.round(6 + 34 * k) + ':allf=t+u'];
    case 'mirror':   return ['hflip'];
    case 'duotone':  return ['hue=s=0', 'colorchannelmixer=rr=0.25:rg=0.35:rb=0.4:gr=0.25:gg=0.4:gb=0.5:br=0.5:bg=0.6:bb=0.95'];
    case 'dreamy':   return ['gblur=sigma=' + (2 + 6 * k).toFixed(2) + ':steps=1', 'eq=brightness=' + (0.03 + 0.05 * k).toFixed(3)];
    case 'vhs':      return ['noise=alls=' + Math.round(4 + 16 * k) + ':allf=t', 'chromashift=cbh=' + Math.round(2 + 6 * k)];
    case 'glitch':   return ['chromashift=cbh=' + Math.round(4 + 12 * k) + ':crh=-' + Math.round(4 + 12 * k)];
    case 'leak':     return ['colorchannelmixer=rr=' + (1 + 0.25 * k).toFixed(3) + ':gg=1:bb=' + (1 - 0.15 * k).toFixed(3), 'vignette=mode=backward:angle=' + (0.6 * k).toFixed(3)];
    default: return [];
  }
}

/* ── Geometria kadru: 1:1 z clipGeom() w studio.php ─────────────────────── */
function clipGeom(c, sw, sh, W, H) {
  const zoom = Math.max(1, nz(c.zoom, 1));
  let sc, dw, dh, dx, dy;
  if (c.fill === false) {
    sc = Math.min(W / sw, H / sh) * zoom; dw = sw * sc; dh = sh * sc; dx = (W - dw) / 2; dy = (H - dh) / 2;
  } else {
    sc = Math.max(W / sw, H / sh) * zoom; dw = sw * sc; dh = sh * sc;
    const cx = nz(c.cropX, 0.5), cy = nz(c.cropY, 0.5);
    dx = (W - dw) * cx; dy = (H - dh) * cy;
  }
  return { dx: Math.round(dx), dy: Math.round(dy), dw: Math.round(dw), dh: Math.round(dh) };
}

/* Ken Burns → zoompan (te same wzory co kbGeom w studio-text.js) */
function kenBurns(c, eff, W, H) {
  const mode = c.kb || 'none';
  if (mode === 'none' || !mode) return null;
  const k = nz(c.kbs, 45) / 100;
  const n = Math.max(1, Math.round(eff * FPS));
  const p = 'on/' + n;                                   // postęp 0..1 wg numeru klatki
  let z, x, y;
  switch (mode) {
    case 'zin':  z = '1+' + (0.20 * k) + '*' + p; x = 'iw/2-(iw/zoom/2)'; y = 'ih/2-(ih/zoom/2)'; break;
    case 'zout': z = '1+' + (0.20 * k) + '*(1-' + p + ')'; x = 'iw/2-(iw/zoom/2)'; y = 'ih/2-(ih/zoom/2)'; break;
    case 'panL': z = String(1 + 0.14 * k); x = '(iw-iw/zoom)*(1-' + p + ')'; y = 'ih/2-(ih/zoom/2)'; break;
    case 'panR': z = String(1 + 0.14 * k); x = '(iw-iw/zoom)*' + p;         y = 'ih/2-(ih/zoom/2)'; break;
    case 'panU': z = String(1 + 0.14 * k); x = 'iw/2-(iw/zoom/2)'; y = '(ih-ih/zoom)*(1-' + p + ')'; break;
    case 'panD': z = String(1 + 0.14 * k); x = 'iw/2-(iw/zoom/2)'; y = '(ih-ih/zoom)*' + p; break;
    case 'diag': z = '1+' + (0.10 * k) + '+' + (0.12 * k) + '*' + p; x = '(iw-iw/zoom)*' + p; y = '(ih-ih/zoom)*' + p; break;
    default: return null;                                 // shake/pulse/swing — v1 bez ruchu
  }
  return "zoompan=z='" + z + "':x='" + x + "':y='" + y + "':d=1:s=" + W + 'x' + H + ':fps=' + FPS;
}

function clipEffDur(c) {
  if (!c) return 0;
  if (c.type === 'image') return Math.max(0.3, nz(c.imgDur, 3));
  const raw = Math.max(0.05, nz(c.out, nz(c.dur, 0)) - nz(c.in, 0));
  return raw / (nz(c.speed, 1) || 1);
}

/* atempo przyjmuje 0.5–2.0 → łańcuch dla skrajnych prędkości */
function atempoChain(speed) {
  let s = nz(speed, 1), out = [];
  if (Math.abs(s - 1) < 0.001) return [];
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s *= 2; }
  out.push('atempo=' + s.toFixed(4));
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   1) NORMALIZACJA KLIPU — każdy klip → part_i.mp4 o identycznych parametrach
   (rozmiar, fps, kodek, ścieżka audio). Dzięki temu sklejenie to concat -c copy
   (błyskawiczne), a nie jeden gigantyczny filter_complex, który przy 50 klipach
   wywraca ffmpeg i zjada pamięć.
   ══════════════════════════════════════════════════════════════════════════ */
async function normalizeClip(c, file, out, W, H, job) {
  const eff = clipEffDur(c);
  const isImg = c.type === 'image';
  const speed = nz(c.speed, 1) || 1;
  const info = await probeInfo(file);
  const sw = info.w || W, sh = info.h || H;

  const args = [];
  if (isImg) {
    args.push('-loop', '1', '-t', String(eff), '-i', file);
  } else {
    const inSec = nz(c.in, 0), outSec = nz(c.out, nz(c.dur, 0));
    args.push('-ss', String(inSec));
    if (outSec > inSec) args.push('-to', String(outSec));
    args.push('-i', file);
  }

  // czarne płótno WxH — kadr składamy przez overlay, NIE przez pad:
  // przy fill=true skalowany obraz jest WIĘKSZY od kadru i offsety bywają
  // ujemne (pad tego nie umie, overlay tak) — to jest dokładnie to, co robi
  // drawImage(src, dx, dy, dw, dh) w edytorze.
  args.push('-f', 'lavfi', '-i', 'color=c=black:s=' + W + 'x' + H + ':r=' + FPS);
  const hasAudio = !isImg && info.hasAudio;
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');

  const g = clipGeom(c, sw, sh, W, H);
  const kb = kenBurns(c, eff, g.dw, g.dh);
  const fc = [];
  const pre = ['scale=' + g.dw + ':' + g.dh + ':flags=bicubic'];
  if (kb) pre.push(kb);
  if (!isImg && Math.abs(speed - 1) > 0.001) pre.push('setpts=' + (1 / speed).toFixed(6) + '*PTS');
  fc.push('[0:v]' + pre.join(',') + '[s]');
  fc.push('[1:v][s]overlay=' + g.dx + ':' + g.dy + ':shortest=1[v0]');

  const vf = [];
  // efekt obrazu — ten sam łańcuch CSS co w podglądzie
  cssFilterToFfmpeg(c.cssFilter).forEach(f => vf.push(f));
  postFxFilters(c.effect, c.fx).forEach(f => vf.push(f));

  // przejście „fade" = wejście/wyjście klipu (jak w montDrawFrame)
  if (c.trans === 'fade' && eff > FADE_D * 2) {
    vf.push('fade=t=in:st=0:d=' + FADE_D);
    vf.push('fade=t=out:st=' + (eff - FADE_D).toFixed(3) + ':d=' + FADE_D);
  }
  vf.push('fps=' + FPS, 'format=yuv420p', 'setsar=1');
  fc.push('[v0]' + vf.join(',') + '[v]');

  if (hasAudio) {
    const af = atempoChain(speed);
    const vol = nz(c.vol, nz(job.project.clipVol, 1));
    if (vol !== 1) af.push('volume=' + vol.toFixed(3));
    af.push('aresample=48000');
    fc.push('[0:a]' + af.join(',') + '[a]');
  }

  args.push('-filter_complex', fc.join(';'), '-map', '[v]');
  args.push('-map', hasAudio ? '[a]' : '2:a');

  args.push('-t', String(eff),
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, ...X264(),
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', out);

  await ffmpeg(args);
}

/* ══════════════════════════════════════════════════════════════════════════
   2) WARSTWA TEKSTU
   ─────────────────────────────────────────────────────────────────────────
   ŚCIEŻKA GŁÓWNA: napisy rasteryzuje STUDIO (`tx.png` — przezroczysty PNG
   pełnoklatkowy, narysowany prawdziwym montDrawTexts na prawdziwym canvasie).
   Zalety: piksel w piksel jak podgląd, zero Chromium na serwerze.
   To NIE jest optymalizacja z wygody — Chromium + ffmpeg nie mieszczą się
   w 512 MB instancji Free („Ran out of memory", 15.07). Rysowanie tekstu na
   canvasie działa też na iOS Safari (tam padają MediaRecorder/ctx.filter,
   nie canvas), więc telefon nadal wysyła sam opis + kilka PNG-ów.

   ŚCIEŻKA ZAPASOWA: gdy klient nie dostarczy `png`, próbujemy Puppeteera
   (text-layer.html z kodem wyciętym ze studio-text.js) — sensowne dopiero
   przy większej instancji.
   ══════════════════════════════════════════════════════════════════════════ */
async function textPNGsFromClient(texts, dir) {
  const outs = [];
  for (let i = 0; i < texts.length; i++) {
    const tx = texts[i];
    if (!tx || !tx.png || !/^data:image\/png;base64,/.test(tx.png)) continue;
    const f = path.join(dir, 'txt_' + i + '.png');
    await fsp.writeFile(f, Buffer.from(tx.png.split(',')[1], 'base64'));
    outs.push({ file: f, start: nz(tx.start, 0), end: nz(tx.end, nz(tx.start, 0) + 5) });
  }
  return outs;
}

async function renderTextPNGs(texts, W, H, dir, puppeteer) {
  if (!texts || !texts.length || !puppeteer) return [];
  const html = 'file://' + path.join(__dirname, 'text-layer.html');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
  });
  const outs = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.goto(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    for (let i = 0; i < texts.length; i++) {
      const tx = texts[i];
      if (tx.logo) continue;                       // logo marki — v1 pomijamy (rysuje je edytor)
      const st = nz(tx.start, 0), en = nz(tx.end, st + 5);
      const mid = st + Math.max(0.01, (en - st)) / 2;   // stan „ustabilizowany" (po animacji wejścia)
      const b64 = await page.evaluate((t, tt, w, h) => window.wpRenderTextPNG(t, tt, w, h), tx, mid, W, H);
      if (!b64) continue;
      const f = path.join(dir, 'txt_' + i + '.png');
      await fsp.writeFile(f, Buffer.from(b64, 'base64'));
      outs.push({ file: f, start: st, end: en });
    }
  } finally { await browser.close(); }
  return outs;
}

/* ══════════════════════════════════════════════════════════════════════════
   3) SKLEJENIE + WARSTWY + AUDIO
   ══════════════════════════════════════════════════════════════════════════ */
async function concatParts(parts, dir) {
  const list = path.join(dir, 'list.txt');
  await fsp.writeFile(list, parts.map(p => "file '" + p.replace(/'/g, "'\\''") + "'").join('\n'));
  const out = path.join(dir, 'concat.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
  return out;
}

async function finalPass(job, dir, base, overlayPng, textPngs, total, W, H) {
  const P = job.project;

  // wejścia: 0 = sklejony materiał, potem nakładka, napisy, muzyka, lektor
  const inputs = [base];
  if (overlayPng) inputs.push(overlayPng);
  textPngs.forEach(t => inputs.push(t.file));
  const musicIdx = (P.music && P.music.url && job.files.music) ? inputs.push(job.files.music) - 1 : -1;
  const voIdx = (P.vo && P.vo.url && job.files.vo) ? inputs.push(job.files.vo) - 1 : -1;

  const a2 = [];
  inputs.forEach(f => { a2.push('-i', f); });

  const fc = [];
  let vlab = '[0:v]';
  let n = 1;
  if (overlayPng) {
    // „contain" — jak drawImage w montDrawFrame: bez deformacji, wyśrodkowana
    const ovS = nz(P.ovStart, 0), ovE = nz(P.ovEnd, 0) > 0 ? nz(P.ovEnd, 0) : total;
    fc.push('[' + n + ':v]scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease[ov' + n + ']');
    fc.push(vlab + '[ov' + n + ']overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:format=auto' +
      ":enable='between(t," + ovS.toFixed(3) + ',' + ovE.toFixed(3) + ")'[vo" + n + ']');
    vlab = '[vo' + n + ']'; n++;
  }
  textPngs.forEach(t => {
    fc.push('[' + n + ':v]scale=' + W + ':' + H + '[ov' + n + ']');
    fc.push(vlab + '[ov' + n + "]overlay=0:0:format=auto:enable='between(t," + t.start.toFixed(3) + ',' + t.end.toFixed(3) + ")'[vo" + n + ']');
    vlab = '[vo' + n + ']'; n++;
  });

  // audio: dźwięk klipów + podkład (zapętlony, przycięty) + lektor
  const amix = ['[0:a]'];
  if (musicIdx > 0) {
    const mv = nz(P.music.vol, 0.6);
    fc.push('[' + musicIdx + ':a]aloop=loop=-1:size=2e9,atrim=0:' + total.toFixed(3) +
      ',volume=' + mv.toFixed(3) + ',aresample=48000[mus]');
    amix.push('[mus]');
  }
  if (voIdx > 0) {
    const vv = nz(P.vo.vol, 1);
    fc.push('[' + voIdx + ':a]volume=' + vv.toFixed(3) + ',aresample=48000[voi]');
    amix.push('[voi]');
  }
  let alab = '0:a';
  if (amix.length > 1) {
    fc.push(amix.join('') + 'amix=inputs=' + amix.length + ':duration=first:dropout_transition=0:normalize=0[amixed]');
    alab = '[amixed]';
  }

  const out = path.join(dir, 'final.mp4');
  const final = [...a2];
  if (fc.length) final.push('-filter_complex', fc.join(';'));
  final.push('-map', vlab === '[0:v]' ? '0:v' : vlab,
    '-map', alab, '-t', String(total),
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, ...X264(),
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', out);

  await ffmpeg(final, {
    onLine: line => {
      const m = /^out_time_ms=(\d+)/.exec(line);
      if (m && total > 0) {
        const done = Number(m[1]) / 1e6 / total;
        job.progress = Math.min(0.99, 0.6 + 0.39 * done);   // 60→99% to ostatni przebieg
      }
    }
  });
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   „UTNIJ FILM DO NARRACJI" — realny koniec mowy, nie koniec taśmy.
   ─────────────────────────────────────────────────────────────────────────
   Dwa scenariusze, jedna funkcja:
   1) jest OSOBNY lektor (P.vo) → film ma trwać tyle co lektor;
   2) narracją jest DŹWIĘK KLIPÓW (nagranie prezentera) → szukamy ostatniego
      momentu mowy przez silencedetect na sklejonym materiale i tam kończymy.
   Zwraca sekundę końca narracji (bez padu) albo 0, gdy nie ma czego przycinać.
   ══════════════════════════════════════════════════════════════════════════ */
/* Długość SAMEJ ścieżki audio (nie kontenera!). Gdy obraz jest dłuższy od
   dźwięku, format.duration pokazuje długość obrazu — a nas interesuje audio. */
function audioStreamDur(file) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=duration', '-of',
      'default=nokey=1:noprint_wrappers=1', file]);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => { const v = parseFloat(out); resolve(Number.isFinite(v) && v > 0 ? v : 0); });
    p.on('error', () => resolve(0));
  });
}

async function narrationEnd(job, base) {
  const P = job.project;
  // 1) osobny lektor rządzi długością filmu
  if (P.vo && P.vo.url && job.files && job.files.vo) {
    const a = await audioStreamDur(job.files.vo);
    if (a > 0) return a;
    const i = await probeInfo(job.files.vo);
    if (i.dur > 0) return i.dur;
  }
  // 2) narracja = audio klipów; ostatni niecichy punkt przez silencedetect
  const info = await probeInfo(base);
  if (!info.hasAudio) return 0;
  // długość ścieżki audio: preferuj stream=duration, w ostateczności kontener
  let aDur = await audioStreamDur(base);
  let lastStart = null, lastEnd = null;
  await ffmpeg(
    ['-i', base, '-map', '0:a', '-af',
     'silencedetect=noise=' + FIT_SIL_DB + ':d=' + FIT_SIL_MIN, '-f', 'null', '-'],
    { onLine: line => {
        const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
        if (s) lastStart = Math.max(0, Number(s[1]));
        const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
        if (e) lastEnd = Number(e[1]);
      } }
  );
  if (!(aDur > 0)) aDur = Math.max(info.dur, lastEnd || 0);   // brak stream=duration → z ciszy/kontenera
  if (!(aDur > 0)) return 0;
  // Ostatnia cisza sięgająca końca ścieżki (lastEnd ≈ aDur) = OGON → mowa
  // skończyła się na lastStart. Jeśli po ciszy mowa wróciła (lastEnd < aDur),
  // narracja trwa do końca ścieżki audio.
  const reachesEnd = lastStart != null && (lastEnd == null || lastEnd >= aDur - 0.35 || lastEnd <= lastStart);
  return reachesEnd ? lastStart : aDur;
}

/* ── Główny bieg zadania ────────────────────────────────────────────────── */
async function runJob(job, puppeteer, renderOverlayPNG) {
  const P = job.project;
  const dims = RATIO_DIMS[P.ratio] || RATIO_DIMS['169'];
  const [W, H] = dims;
  const dir = path.join(ROOT, job.id);
  await fsp.mkdir(dir, { recursive: true });
  job.dir = dir;
  job.files = {};
  const budget = { left: MAX_BYTES };

  // 1. pobranie materiałów
  job.status = 'downloading'; job.progress = 0.02;
  const clipFiles = [];
  for (let i = 0; i < P.clips.length; i++) {
    const c = P.clips[i];
    const ext = (c.type === 'image' ? '.img' : '.vid');
    clipFiles.push(await download(c.url, path.join(dir, 'in_' + i + ext), budget));
    job.progress = 0.02 + 0.13 * ((i + 1) / P.clips.length);
  }
  if (P.music && P.music.url) job.files.music = await download(P.music.url, path.join(dir, 'music.bin'), budget);
  if (P.vo && P.vo.url) job.files.vo = await download(P.vo.url, path.join(dir, 'vo.bin'), budget);

  // 2. normalizacja klipów
  job.status = 'rendering';
  const parts = [];
  for (let i = 0; i < P.clips.length; i++) {
    const out = path.join(dir, 'part_' + String(i).padStart(3, '0') + '.mp4');
    await normalizeClip(P.clips[i], clipFiles[i], out, W, H, job);
    parts.push(out);
    job.progress = 0.15 + 0.35 * ((i + 1) / P.clips.length);
    job.step = 'klip ' + (i + 1) + '/' + P.clips.length;
  }

  // 3. warstwy: nakładka broadcast (Puppeteer, jak w /overlay) + napisy
  job.step = 'napisy i nakładki'; job.progress = 0.52;
  // Nakładkę (setka/breaking/bug…) Studio rasteryzuje u siebie — dostajemy
  // gotowy PNG data-URL. Dzięki temu wygląda 1:1 jak w podglądzie i serwer
  // nie musi znać FORMS ani odpalać Puppeteera dla grafiki.
  let overlayPng = null;
  if (P.overlayPng && /^data:image\/png;base64,/.test(P.overlayPng)) {
    overlayPng = path.join(dir, 'overlay.png');
    await fsp.writeFile(overlayPng, Buffer.from(P.overlayPng.split(',')[1], 'base64'));
  } else if (P.overlay && P.overlay.name && renderOverlayPNG) {
    try { overlayPng = await renderOverlayPNG(P.overlay, W, H, dir); }
    catch (e) { job.warn = (job.warn || []).concat('Nakładka pominięta: ' + e.message); }
  }
  let textPngs = [];
  try {
    const texts = P.texts || [];
    const fromClient = await textPNGsFromClient(texts, dir);
    if (fromClient.length) {
      textPngs = fromClient;
    } else if (texts.filter(t => !t.logo).length) {
      // klient nie przysłał gotowych PNG — próba awaryjna przez Chromium
      textPngs = await renderTextPNGs(texts, W, H, dir, puppeteer);
      if (!textPngs.length) job.warn = (job.warn || []).concat('Napisy pominięte (brak rastrów ze Studia)');
    }
  } catch (e) { job.warn = (job.warn || []).concat('Napisy pominięte: ' + e.message); }

  // 4. sklejenie + przebieg finalny
  job.step = 'sklejanie'; job.progress = 0.58;
  const base = parts.length === 1 ? parts[0] : await concatParts(parts, dir);
  let total = P.clips.reduce((s, c) => s + clipEffDur(c), 0);

  // „utnij film do narracji": jeśli obraz jest wyraźnie dłuższy niż mowa,
  // przycinamy do końca narracji + oddech. Wszystko w try/catch — gdyby
  // wykrywanie zawiodło, film wychodzi jak dotąd (pełna długość), tylko z warn.
  if (FIT_TO_AUDIO) {
    try {
      const nar = await narrationEnd(job, base);
      const target = nar + FIT_PAD;
      if (nar > 0 && target >= FIT_MIN_FILM && target < total - FIT_MIN_GAIN) {
        job.warn = (job.warn || []).concat(
          'Film przycięty do narracji: ' + total.toFixed(1) + ' s → ' + target.toFixed(1) + ' s');
        total = target;
      }
    } catch (e) {
      job.warn = (job.warn || []).concat('Dopasowanie do narracji pominięte: ' + e.message);
    }
  }

  job.step = 'render finalny';
  const final = await finalPass(job, dir, base, overlayPng, textPngs, total, W, H);

  // 5. sprzątanie materiałów pośrednich (512 MB dysku na Free)
  for (const f of [...clipFiles, ...parts]) { try { await fsp.unlink(f); } catch {} }
  const st = await fsp.stat(final);
  job.file = final; job.size = st.size; job.status = 'done'; job.progress = 1;
  job.doneAt = Date.now();
}

/* ── Montaż endpointów (additywnie do istniejącego app) ─────────────────── */
export function mountMontage(app, opts = {}) {
  const { renderOverlayPNG, token = process.env.RENDER_TOKEN || '' } = opts;
  // Chromium na serwerze TYLKO na wyraźne życzenie: na instancji 512 MB
  // Puppeteer + ffmpeg = „Ran out of memory". Domyślnie napisy przychodzą
  // gotowe ze Studia (patrz sekcja 2).
  const puppeteer = process.env.MONTAGE_PUPPETEER === '1' ? opts.puppeteer : null;

  // CORS — Studio (www.wiadomosci.pro) woła ten serwis wprost z przeglądarki
  const ORIGINS = (process.env.CORS_ORIGINS ||
    'https://www.wiadomosci.pro,https://wiadomosci.pro').split(',').map(s => s.trim());
  app.use('/montage', (req, res, next) => {
    const o = req.headers.origin;
    if (o && ORIGINS.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const auth = (req, res) => {
    if (!token) return true;
    const b = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (b === token || req.query.token === token) return true;
    res.status(401).json({ error: 'Brak/niepoprawny token' });
    return false;
  };

  app.post('/montage', async (req, res) => {
    if (!auth(req, res)) return;
    const P = req.body || {};
    if (!P.clips || !Array.isArray(P.clips) || !P.clips.length)
      return res.status(400).json({ error: 'Pusty montaż — brak klipów.' });
    if (P.clips.length > MAX_CLIPS)
      return res.status(400).json({ error: 'Za dużo klipów (limit ' + MAX_CLIPS + ').' });
    for (const c of P.clips) {
      if (!c.url || !/^https?:\/\//i.test(c.url))
        return res.status(400).json({ error: 'Każdy klip musi mieć publiczny URL (http/https). Klip „' + (c.name || '?') + '" go nie ma — wyślij go najpierw do biblioteki mediów.' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, status: 'queued', progress: 0, project: P, createdAt: Date.now() };
    jobs.set(id, job);
    queue = queue.then(() => runJob(job, puppeteer, renderOverlayPNG)).catch(e => {
      job.status = 'error'; job.error = String(e.message || e);
      console.error('[montage ' + id + ']', e);
    });
    res.json({ id, status: 'queued', statusUrl: '/montage/' + id, fileUrl: '/montage/' + id + '/file' });
  });

  app.get('/montage/:id', (req, res) => {
    if (!auth(req, res)) return;
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'Nie ma takiego zadania' });
    res.json({
      id: j.id, status: j.status, progress: Math.round((j.progress || 0) * 100),
      step: j.step || null, error: j.error || null, warn: j.warn || null,
      size: j.size || null, url: j.status === 'done' ? '/montage/' + j.id + '/file' : null
    });
  });

  app.get('/montage/:id/file', (req, res) => {
    if (!auth(req, res)) return;
    const j = jobs.get(req.params.id);
    if (!j || j.status !== 'done' || !j.file) return res.status(404).send('Render niegotowy');
    // sendFile obsługuje nagłówek Range — bez tego <video> wisi na wieczystym
    // ładowaniu (readyState=0, networkState=2): odtwarzacz Chrome prosi
    // o zakresy bajtów, a goły stream ich nie umie. „attachment" tylko na
    // wyraźne żądanie (?download=1), żeby podgląd w karcie działał.
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.query.download === '1')
      res.setHeader('Content-Disposition', 'attachment; filename="wiadomosci-pro-montaz.mp4"');
    res.sendFile(j.file, { acceptRanges: true }, err => {
      if (err && !res.headersSent) res.status(500).end();
    });
  });

  app.delete('/montage/:id', async (req, res) => {
    if (!auth(req, res)) return;
    const j = jobs.get(req.params.id);
    if (j && j.dir) { try { await fsp.rm(j.dir, { recursive: true, force: true }); } catch {} }
    jobs.delete(req.params.id);
    res.json({ ok: true });
  });

  // sprzątanie starych zadań (dysk na Free jest mały)
  setInterval(async () => {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (j.doneAt && now - j.doneAt > JOB_TTL_MS) {
        try { await fsp.rm(j.dir, { recursive: true, force: true }); } catch {}
        jobs.delete(id);
      }
    }
  }, 10 * 60 * 1000).unref();

  console.log('[montage] endpoint POST /montage gotowy');
}

export default mountMontage;
