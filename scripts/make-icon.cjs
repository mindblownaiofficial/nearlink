// Renders build/icon.svg to build/icon.png (1024px). electron-builder turns that into .icns and .ico.
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const build = path.join(__dirname, '..', 'build');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    useContentSize: true,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(build, 'icon.svg'));
  await new Promise(resolve => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(build, 'icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
