// 月历概念图截图：electron design/calendar-shot.js → design/calendar-concept.png
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 1100, show: false, frame: false });
  await win.loadFile(path.join(__dirname, 'calendar-concept.html'));
  await new Promise(r => setTimeout(r, 900));
  const h = await win.webContents.executeJavaScript('document.body.scrollHeight').catch(() => 1100);
  win.setBounds({ x: 0, y: 0, width: 900, height: Math.ceil(h) });
  await new Promise(r => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, 'calendar-concept.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('[shot] saved', out, 'h=' + h);
  app.exit(0);
});
