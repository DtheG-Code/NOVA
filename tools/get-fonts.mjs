// Lädt latin-woff2 von Google Fonts herunter und erzeugt src/ui/fonts.css
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FAMILIES = [
  { css: 'family=Space+Grotesk:wght@400;500;600;700', name: 'Space Grotesk' },
  { css: 'family=Orbitron:wght@500;700;900', name: 'Orbitron' },
];

const outDir = path.resolve('src/ui/fonts');
await mkdir(outDir, { recursive: true });

let cssOut = '';
for (const fam of FAMILIES) {
  const res = await fetch(`https://fonts.googleapis.com/css2?${fam.css}&display=swap`, { headers: { 'User-Agent': UA } });
  const css = await res.text();
  // Nur die /* latin */-Blöcke nehmen
  const blocks = css.split('/* ').filter((b) => b.startsWith('latin */'));
  for (const block of blocks) {
    const face = block.slice(block.indexOf('@font-face'));
    const urlMatch = face.match(/url\((https:[^)]+\.woff2)\)/);
    const weightMatch = face.match(/font-weight:\s*(\d+)/);
    if (!urlMatch) continue;
    const weight = weightMatch ? weightMatch[1] : '400';
    const fname = `${fam.name.replace(/ /g, '')}-${weight}.woff2`;
    const buf = Buffer.from(await (await fetch(urlMatch[1], { headers: { 'User-Agent': UA } })).arrayBuffer());
    await writeFile(path.join(outDir, fname), buf);
    cssOut += `@font-face{font-family:'${fam.name}';font-style:normal;font-weight:${weight};font-display:swap;src:url('fonts/${fname}') format('woff2');}\n`;
    console.log('ok', fname, buf.length);
  }
}
await writeFile(path.resolve('src/ui/fonts.css'), cssOut);
console.log('fonts.css written');
