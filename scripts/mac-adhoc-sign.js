const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' }
  );

  console.log(`  • signature ad-hoc appliquée  file=${appPath}`);
};
