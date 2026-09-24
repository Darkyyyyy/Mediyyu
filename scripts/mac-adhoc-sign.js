// Prépare le bundle macOS avant signature : icône en calques puis signature
// ad-hoc. Sans aucune signature, macOS 15+ refuse l'app en la traitant comme un
// logiciel malveillant et la met à la corbeille.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// L'icône Icon Composer ne vit pas dans un .icns : macOS 26+ la rend en verre
// depuis un catalogue compilé, désigné par CFBundleIconName. Le .icns reste
// en place pour les versions antérieures, qui ignorent le catalogue.
// build/Assets.car est produit par scripts/build-mac-icon.js.
function installLayeredIcon(appPath) {
  const car = path.join(__dirname, '..', 'build', 'Assets.car');
  if (!fs.existsSync(car)) {
    console.log('  • pas de build/Assets.car, icône en calques ignorée');
    return;
  }
  fs.copyFileSync(car, path.join(appPath, 'Contents', 'Resources', 'Assets.car'));
  execFileSync('plutil', [
    '-replace', 'CFBundleIconName', '-string', 'Mediyyu',
    path.join(appPath, 'Contents', 'Info.plist'),
  ], { stdio: 'inherit' });
  console.log('  • icône en calques installée  CFBundleIconName=Mediyyu');
}

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  installLayeredIcon(appPath);

  // Les xattr de quarantaine hérités de node_modules invalident la signature.
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' }
  );

  console.log(`  • signature ad-hoc appliquée  file=${appPath}`);
};
