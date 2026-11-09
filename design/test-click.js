'use strict';
/* design/test-click.js — 真实点击回归：验证「今日/本月/累计」分段切换可点。
   用 webContents.sendInputEvent 走真实输入命中链路（-webkit-app-region: drag
   吞点击的坑只有真实输入事件能复现，executeJavaScript 的合成 click 复现不了）。
   运行：env -u ELECTRON_RUN_AS_NODE npx electron design/test-click.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  /* 最小 IPC mock：让渲染层启动时不打「No handler registered」噪声 */
  ipcMain.handle('settings:get', () => ({ theme: 'light', rotateSeconds: 5, refreshMinutes: 5, trendingRange: 'daily', providers: [] }));
  ipcMain.handle('settings:update', () => ({}));
  ipcMain.handle('data:refresh', () => { });
  ipcMain.handle('ext:open', () => true);
  ipcMain.handle('update:state', () => ({ type: 'idle' }));
  const win = new BrowserWindow({
    width: 420, height: 840, frame: false, transparent: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, spellcheck: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 900));

  const clickAt = (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const center = (sel) => win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector(${JSON.stringify(sel)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);

  const results = [];
  for (const [key, expect] of [['month', '本月'], ['total', '累计'], ['day', '今日']]) {
    const p = await center(`#segRange button[data-r="${key}"]`);
    if (!p) { results.push(`${key}: FAIL(按钮不存在)`); continue; }
    clickAt(p.x, p.y);
    await new Promise(r => setTimeout(r, 250));
    const label = await win.webContents.executeJavaScript(`document.getElementById('tLabel').textContent`);
    results.push(`${key}: ${label.includes(expect) ? 'PASS' : 'FAIL'}(${label})`);
  }
  console.log('[click-test]', results.join(' | '));
  console.log('[click-test]', results.every(r => r.includes('PASS')) ? 'ALL PASS' : 'HAS FAIL');
  app.exit(0);
});
