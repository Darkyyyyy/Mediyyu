#!/usr/bin/env node
// Compile l'icone Icon Composer (build/*.icon) vers les deux formes dont le
// bundle a besoin :
//   - Assets.car : l'icone en calques, que macOS 26+ rend en verre
//   - icon.icns  : l'aplat de repli, pour les macOS anterieurs et le volume dmg
//
// actool fait les deux, mais il exige Xcode complet. Les fichiers produits sont
// versionnes, pour que le build ne depende pas de Xcode sur la machine.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUILD = path.join(__dirname, '..', 'build');
const ICON_NAME = 'Mediyyu';

const source = fs.readdirSync(BUILD).find((f) => f.endsWith('.icon'));
if (!source) {
  console.error('aucun fichier .icon dans build/');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediyyu-icon-'));
const staged = path.join(tmp, `${ICON_NAME}.icon`);
const out = path.join(tmp, 'out');
fs.mkdirSync(out);
// actool nomme l'asset d'apres le fichier : il doit s'appeler comme la valeur
// qu'on ecrira dans CFBundleIconName.
fs.cpSync(path.join(BUILD, source), staged, { recursive: true });

execFileSync('xcrun', [
  'actool',
  '--output-format', 'human-readable-text',
  '--notices', '--warnings', '--errors',
  '--output-partial-info-plist', path.join(tmp, 'part.plist'),
  '--app-icon', ICON_NAME,
  '--enable-on-demand-resources', 'NO',
  '--development-region', 'en',
  '--target-device', 'mac',
  '--minimum-deployment-target', '26.0',
  '--platform', 'macosx',
  '--compile', out,
  staged,
], { stdio: 'inherit' });

fs.copyFileSync(path.join(out, 'Assets.car'), path.join(BUILD, 'Assets.car'));
fs.copyFileSync(path.join(out, `${ICON_NAME}.icns`), path.join(BUILD, 'icon.icns'));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`compile depuis ${source}`);
console.log('  build/Assets.car  (icone en calques)');
console.log('  build/icon.icns   (repli aplati)');
