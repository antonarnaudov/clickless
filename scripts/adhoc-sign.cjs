// electron-builder afterPack hook: without an Apple developer certificate (mac.identity is null)
// the app would ship with Electron's broken linker signature, which Apple silicon refuses to open.
// An ad-hoc signature over the whole bundle makes it launch on the machine that built it (and,
// after right-click → Open, on others). Replaced by real signing once there's a certificate.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${path.basename(app)}`);
};
