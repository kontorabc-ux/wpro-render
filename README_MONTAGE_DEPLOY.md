# POST /montage — render montażu na serwerze (wdrożenie)

**Data:** 2026-07-15  ·  **Status:** kod gotowy i przetestowany lokalnie, **czeka na wypchnięcie do repo**

## Co to naprawia

Studio renderowało film w przeglądarce (`canvas.captureStream` + `MediaRecorder` + `ctx.filter`).
Na iPhonie/Safari to nie działa (stąd „retusz nic nie zmienia", „efekty martwe", render 15 min
przez `ffmpeg.wasm`). Teraz Studio wysyła **sam opis montażu (JSON)**, a mikroserwis składa film
**natywnym ffmpeg**. Telefon tylko wysyła JSON — reszta dzieje się na serwerze.

## Pliki (wszystko ADDITYWNE — nic istniejącego nie jest przepisywane)

| Plik | Co to |
|---|---|
| `montage.js` | **NOWY** — cały endpoint: kolejka async, pobieranie materiałów, budowa grafu ffmpeg, warstwy, miks audio, statusy |
| `text-layer.html` | **NOWY** (generowany) — strona dla Puppeteera z **prawdziwym** kodem rysowania napisów wyciętym ze `studio-text.js`, żeby napisy były 1:1 z podglądem |
| `build-text-layer.mjs` | **NOWY** — generator powyższego; uruchamiać po każdej zmianie stylów napisów: `node build-text-layer.mjs <live studio-text.js>` |
| `server.js` | **2 dopiski** (import + montaż endpointu przed `app.listen`) |
| `package.json`, `Dockerfile` | **bez zmian** — ffmpeg i puppeteer już są w obrazie |

## Zmiany w server.js (dokładnie te dwie)

1. w bloku importów, po `import { fileURLToPath, pathToFileURL } from 'url';`:

```js
import { mountMontage } from './montage.js';
```

2. tuż przed `app.listen(PORT, ...)`:

```js
/* ── RENDER SERWEROWY MONTAŻU (POST /montage) ── dołożone 2026-07-15 */
app.use('/montage', express.json({ limit: '32mb' }));
mountMontage(app, { puppeteer, token: TOKEN });
```

> **Uwaga:** wersja `server.js` w repo (6379 B) **nie ma** endpointu `POST /mp3`, który jest
> w kopii lokalnej. Czyli `/mp3` nigdy nie został wdrożony. Świadomie go tu **nie** dokładam —
> to osobna decyzja, żeby ten deploy zmieniał jedną rzecz naraz.

## API

```
POST /montage           → {id, statusUrl, fileUrl}      (odpowiada natychmiast)
GET  /montage/:id       → {status, progress, step, warn, error, url}
GET  /montage/:id/file  → MP4
DELETE /montage/:id     → sprząta
```

`status`: `queued → downloading → rendering → done | error`. Render idzie w tle (kolejka 1 zadanie
naraz — 512 MB RAM planu Free nie zniesie dwóch ffmpegów). Gotowy plik żyje **1 godzinę**.

## Jak wygląda render (co mapuje się na co)

| Edytor | ffmpeg |
|---|---|
| `in`/`out` | `-ss` / `-to` |
| `speed` | `setpts=1/s*PTS` + `atempo` (łańcuch dla <0.5 i >2) |
| `fill/cropX/cropY/zoom` (`clipGeom`) | `scale` + `overlay` na czarnym płótnie (**nie `pad`** — przy „wypełnij" obraz jest większy od kadru i offsety bywają ujemne) |
| `kb` (Ken Burns) | `zoompan` z tymi samymi wzorami co `kbGeom` |
| efekty `FX` (łańcuch CSS) | tłumaczone 1:1 (`grayscale→hue=s`, `brightness→colorchannelmixer`, `sepia→colorchannelmixer`, `blur→gblur`, `invert→lutrgb`…) |
| `vignette/grain/mirror/duotone/vhs/glitch/leak/dreamy` | odpowiedniki ffmpeg (`vignette`, `noise`, `hflip`, `chromashift`…) |
| `trans:'fade'` | `fade=in`/`fade=out` po 0.4 s (ta sama stała `fd`) |
| napisy `MONT.texts` | PNG z Puppeteera (kod z `studio-text.js`) → `overlay ... enable='between(t,start,end)'` |
| nakładka (setka/breaking) | PNG **rasteryzowany w Studiu** i wysłany w JSON-ie → `overlay` „contain" w zakresie `ovStart/ovEnd` |
| muzyka + lektor + dźwięk klipów | `aloop`+`atrim`+`volume` → `amix` |

## Czego v1 NIE robi (świadomie, bez ściemy)

- **animacje napisów i karaoke** — napis renderuje się w stanie „po animacji wejścia"
  (jeden PNG na napis). Ruchome karaoke wymaga sekwencji PNG — to v2.
- **Ken Burns `shake` / `pulse` / `swing`** — pozostałe tryby (zoom/pan/diag) działają.
- **retusz/beauty per-klip** (`c.beauty`) — nie jest przenoszony na serwer.
- **`drawLayers`** (stopki/loga/plansze jako warstwy) — nie są renderowane serwerowo.
- Napisy i nakładka są opakowane w `try/catch`: jeśli coś padnie, **film i tak się wyrenderuje**,
  a w statusie wraca `warn`.

## Testy wykonane

- ✅ pełny przebieg lokalnie (Node 22 + ffmpeg 5): 3 klipy (wideo z audio + zdjęcie + wideo 2×),
  efekty, Ken Burns, fade, muzyka → **MP4 1920×1080 h264+aac, długość dokładnie 9.000 s**
  (4 + 3 + 2 — zgodnie z `clipEffDur`), statusy i progres działają.
- ✅ `node --check` dla `montage.js` i klienta; kod wycięty do `text-layer.html` parsuje się.
- ⚠️ **ścieżka napisów (Puppeteer) niesprawdzona lokalnie** — piaskownica nie pobiera Chromium
  (403). Do zweryfikowania na Render zaraz po deployu: render z jednym napisem → w statusie
  ma NIE być `warn`, a napis ma być w kadrze.

## Deploy

1. GitHub → `kontorabc-ux/wpro-render` → **Add file → Upload files**: `montage.js`, `text-layer.html`,
   `build-text-layer.mjs` → Commit.
2. `server.js` → ołówek (Edit) → dwa dopiski wyżej → Commit.
3. Render.com → usługa `wpro-render` (srv-d918c17avr4c739blog0) → **Manual Deploy → Deploy latest commit**.
   (Auto-deploy z GitHuba bywa wyłączony.)
4. Smoke test: `GET https://wpro-render.onrender.com/health` (Free budzi się ~50 s), potem render
   testowy ze Studia.

### ENV (opcjonalnie)
- `CORS_ORIGINS` — domyślnie `https://www.wiadomosci.pro,https://wiadomosci.pro`
- `RENDER_TOKEN` — jeśli ustawisz, Studio musi wysyłać `Authorization: Bearer …`. **Dziś puste
  = endpoint otwarty** (tak jak reszta serwisu). Do utwardzenia osobno.
- `FF_PRESET` (domyślnie `veryfast`), `FF_CRF` (`21`).
