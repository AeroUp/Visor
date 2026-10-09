'use strict';
// Takes docs/screenshot.png: the overlay UI in --demo mode (public stand-in account and games)
// over the current demo game's thumbnail. Run: npm run screenshot
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshot.png');
const PORT = 5179;
const W = 1600;
const H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gameThumbnail(placeId) {
  const u = await (await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)).json();
  const t = await (await fetch(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${u.universeId}&size=768x432&format=Png`)).json();
  const url = t.data?.[0]?.thumbnails?.[0]?.imageUrl;
  if (!url) return null;
  const file = path.join(app.getPath('temp'), 'visor-shot-bg.png');
  fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  return file;
}

app.whenReady().then(async () => {
  const bg = await gameThumbnail('189707').catch(() => null);
  const server = spawn('node', [path.join(ROOT, 'tools', 'preview.js'), '--demo', ...(bg ? [`--bg=${bg}`] : [])], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  });
  try {
    await sleep(1500);
    const win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { zoomFactor: 1 } });
    await win.loadURL(`http://localhost:${PORT}`);
    await sleep(9000); // let widgets fetch live data and thumbnails
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, image.resize({ width: W }).toPNG());
    console.log('wrote', path.relative(ROOT, OUT));
  } finally {
    server.kill();
    app.quit();
  }
});
