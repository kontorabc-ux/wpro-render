/* Generator text-layer.html — WIADOMOŚCI PRO
   ─────────────────────────────────────────────────────────────────────────
   PO CO: żeby napisy w renderze serwerowym wyglądały 1:1 jak w podglądzie,
   serwer NIE ma własnej implementacji rysowania tekstu. Wycinamy prawdziwy
   kod z cms/studio-text.js (FONTS, presety, migrate, animState, montDrawTexts…)
   i wklejamy do strony, którą otwiera Puppeteer. Jedno źródło prawdy.

   UŻYCIE (po każdej zmianie stylów napisów w studio-text.js):
     node build-text-layer.mjs /ścieżka/do/live/studio-text.js
   ŹRÓDŁEM MA BYĆ PLIK POBRANY Z LIVE, nie kopia z dysku (live ≠ local).
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('Podaj ścieżkę do studio-text.js (najlepiej pobranego z LIVE)'); process.exit(1); }

const all = fs.readFileSync(src, 'utf8').split('\n');

// Bierzemy od początku pliku do końca funkcji montDrawTexts — to domyka
// wszystkie zależności (FONTS, GF, migrate, fontStr, wordsOf, wrapTokens,
// roundRect, hex2rgba, wordW, bgPad, animState, drawWord…).
const startIdx = 0;
const dtIdx = all.findIndex(l => l.includes('window.montDrawTexts'));
if (dtIdx < 0) { console.error('Nie znalazłem window.montDrawTexts — zmienił się plik?'); process.exit(1); }
let endIdx = -1;
for (let i = dtIdx; i < all.length; i++) { if (/^\};\s*$/.test(all[i])) { endIdx = i; break; } }
if (endIdx < 0) { console.error('Nie znalazłem końca montDrawTexts'); process.exit(1); }

const code = all.slice(startIdx, endIdx + 1).join('\n');

const html = `<!doctype html>
<meta charset="utf-8">
<title>WPRO — warstwa napisów (render serwerowy)</title>
<!-- WYGENEROWANE AUTOMATYCZNIE przez build-text-layer.mjs — nie edytuj ręcznie.
     Źródło: cms/studio-text.js (linie 1-${endIdx + 1}), ${new Date().toISOString()} -->
<style>html,body{margin:0;background:transparent}canvas{display:block}</style>
<canvas id="cv"></canvas>
<script>
/* Namiastki globali ze studio.php, na których opiera się montDrawTexts */
window.MONT = { texts: [], preset: null };
window.montCanvas = document.getElementById('cv');
window.montCtx = window.montCanvas.getContext('2d');
window.montRenderTexts = function(){};
window.montDrawStatic  = function(){};
window.montSelect      = function(){};
window.aiSay           = function(){};
</script>
<script>
${code}
})();
</script>
<script>
/* Ładujemy WSZYSTKIE czcionki edytora (te same rodziny co w studio-text.js) */
(function(){
  const add = href => { const l=document.createElement('link'); l.rel='stylesheet'; l.href=href; document.head.appendChild(l); };
  add('https://fonts.googleapis.com/css2?family=Anton&family=Archivo+Black&family=Bangers'
    + '&family=Bebas+Neue&family=Caveat:wght@700&family=Inter:wght@400;600;900'
    + '&family=Luckiest+Guy&family=Montserrat:wght@700;900&family=Oswald:wght@400;600;700'
    + '&family=Permanent+Marker&family=Playfair+Display:ital,wght@0,700;1,700'
    + '&family=Poppins:wght@600;800&family=Rubik:wght@700;900&display=swap');
  add('https://fonts.googleapis.com/css2?family=Kanit:wght@600;700;900&family=Sora:wght@600;700;800'
    + '&family=Space+Grotesk:wght@600;700&family=Manrope:wght@700;800&family=Outfit:wght@600;800'
    + '&family=Teko:wght@600;700&family=Fredoka:wght@600;700&family=Righteous&display=swap');
})();

/* API dla Puppeteera: jeden tekst → przezroczysty PNG pełnoklatkowy (base64) */
window.wpRenderTextPNG = async function(tx, t, W, H){
  const cv = window.montCanvas;
  cv.width = W; cv.height = H;
  window.montCtx = cv.getContext('2d');
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch(e){}
  window.montCtx.clearRect(0, 0, W, H);
  window.MONT.texts = [tx];
  try { window.montDrawTexts(t, W, H); } catch(e){ return null; }
  const url = cv.toDataURL('image/png');
  return url.split(',')[1] || null;
};
</script>
`;

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'text-layer.html');
fs.writeFileSync(out, html);
console.log('OK → ' + out + ' (' + html.length + ' B, kod z linii 1-' + (endIdx + 1) + ')');
