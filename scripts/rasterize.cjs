// Renders an SVG to a transparent PNG with Electron's offscreen renderer.
//   electron scripts/rasterize.cjs <in.svg> <out.png> <size>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [inFile, outFile, sizeArg] = process.argv.slice(-3);
const size = Number(sizeArg) || 1024;
app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  const svg = fs.readFileSync(path.resolve(inFile), 'utf8').replace(/width="120" height="120"/, `width="${size}" height="${size}"`);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.writeFileSync(path.resolve(outFile), img.resize({ width: size, height: size }).toPNG());
  app.quit();
});
