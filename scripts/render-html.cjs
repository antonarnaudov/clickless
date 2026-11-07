// Renders an HTML file to a PNG with Electron's offscreen renderer (transparent background allowed).
//   electron scripts/render-html.cjs <in.html> <out.png> <width> <height> [scale]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [inFile, outFile, w, h, s] = process.argv.slice(2);
const width = Number(w), height = Number(h), scale = Number(s) || 1;
app.dock?.hide();
app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.resolve(inFile));
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  fs.writeFileSync(path.resolve(outFile), img.toPNG());
  app.quit();
});
