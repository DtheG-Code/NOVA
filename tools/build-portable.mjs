// Baut ein portables Windows-Release nach release/NOVA.
// Trick: das signierte castLabs-electron.exe wird nur UMBENANNT (Bytes unverändert)
// → die Widevine-VMP-Signatur bleibt gültig (electron.exe.sig → NOVA.exe.sig).
import { cpSync, rmSync, mkdirSync, existsSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'node_modules', 'electron', 'dist');
const out = path.join(root, 'release', 'NOVA');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const PRODUCT = 'NOVA';

if (!existsSync(path.join(dist, 'electron.exe'))) {
  console.error('FEHLER: node_modules/electron/dist/electron.exe fehlt. Erst `npm install` ausführen.');
  process.exit(1);
}

console.log('• Räume', out, 'auf …');
rmSync(path.join(root, 'release'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log('• Kopiere Electron-Runtime (~200 MB) …');
cpSync(dist, out, { recursive: true });

// electron.exe → NOVA.exe (Bytes unverändert → Signatur bleibt gültig)
console.log('• Benenne Binary in', PRODUCT + '.exe um (Signatur bleibt erhalten) …');
renameSync(path.join(out, 'electron.exe'), path.join(out, PRODUCT + '.exe'));
if (existsSync(path.join(out, 'electron.exe.sig'))) {
  renameSync(path.join(out, 'electron.exe.sig'), path.join(out, PRODUCT + '.exe.sig'));
  console.log('  ✓ VMP-Signatur (NOVA.exe.sig) übernommen');
} else {
  console.warn('  ! Keine VMP-Signatur gefunden — Musik-DRM erst nach `npm run sign` verfügbar');
}

// App nach resources/app legen (electron lädt das automatisch)
const appDir = path.join(out, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
console.log('• Kopiere App-Quellen …');
cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });

// schlanke Runtime-package.json (ohne devDependencies)
writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version,
  description: pkg.description, main: 'src/main.js', author: pkg.author,
}, null, 2));

// node_modules OHNE electron mitkopieren (nur Runtime-Deps wie @ghostery)
console.log('• Kopiere Runtime-Abhängigkeiten (ohne electron) …');
const nm = path.join(root, 'node_modules');
const electronDir = path.join(nm, 'electron');
cpSync(nm, path.join(appDir, 'node_modules'), {
  recursive: true,
  filter: (s) => {
    if (s === electronDir || s.startsWith(electronDir + path.sep)) return false;
    if (s.includes(path.sep + '.bin')) return false;
    if (s.includes(path.sep + '.cache')) return false;
    return true;
  },
});

// Portable-Marker → App nutzt ein eigenes Profil (NovaData) neben der EXE = Werkseinstellungen
writeFileSync(path.join(out, 'NOVA.portable'), 'NOVA portable profile marker\n');

console.log('\n✓ Fertig:', out);
console.log('  Starten:', path.join(out, PRODUCT + '.exe'));
console.log('  Profil:  NovaData neben der EXE (Werkseinstellungen)');
