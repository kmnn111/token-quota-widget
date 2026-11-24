'use strict';
/* design/shot-antigravity.js — Antigravity 数据源效果预览图
   独立窗口 + mock IPC，注入一份真实形态的 AG 快照，截额度页卡片效果。
   运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron design/shot-antigravity.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-agy-shot-'));
const now = Date.now();
const iso = h => new Date(now + h * 3600e3).toISOString();

/* 贴近真实 RPC 解析结果的快照（AI Credits 月 + 两个模型组的 5h/周） */
const AG = {
  id: 'antigravity-shot', name: 'Antigravity', color: '#7ec8e3',
  status: 'ok', plan: 'Google AI Pro', source: 'antigravity-local',
  updatedAt: now, error: '',
  windows: [
    { label: 'AI Credits · 本月', used: 380, limit: 1000, leftPct: 62, unit: 'credits', resetAt: null, resetType: 'monthly' },
    { label: 'Gemini 3 Pro · 5 小时', used: null, limit: null, leftPct: 42, unit: 'percent', resetAt: iso(2), resetType: 'session' },
    { label: 'Gemini 3 Pro · 本周', used: null, limit: null, leftPct: 70, unit: 'percent', resetAt: iso(72), resetType: 'weekly' },
    { label: 'Claude Sonnet 4.5 · 5 小时', used: null, limit: null, leftPct: 5, unit: 'percent', resetAt: iso(0.75), resetType: 'session' }
  ],
  balance: null
};

const snap = {
  snapshot: {
    providers: [AG],
    usage: {
      day: 4200000, month: 98000000, total: 460000000,
      costDay: '¥12.30', costMonth: '¥287.40', perDay: {}, perDayInfo: {},
      tools: [], sessions: []
    },
    at: now
  },
  trending: { items: [] }, at: now
};

app.whenReady().then(async () => {
  const settings = { demo: false, theme: 'light', refreshMinutes: 5, rotateSeconds: 5, rotateEnabled: true,
    showClock: true, alwaysOnTop: false, trendingEnabled: false, trendingRange: 'daily',
    quotaAlert: true, quotaAlertPct: 10, providers: [{ id: AG.id, type: 'antigravity', name: 'Antigravity', enabled: true }] };
  ipcMain.handle('settings:get', () => JSON.parse(JSON.stringify(settings)));
  ipcMain.handle('settings:update', (_e, patch) => Object.assign(settings, patch) && JSON.parse(JSON.stringify(settings)));
  ipcMain.handle('data:refresh', () => { });
  ipcMain.handle('data:export', () => ({ ok: true, path: '', rows: 0 }));
  ipcMain.handle('ext:open', () => true);
  ipcMain.handle('update:state', () => ({ type: 'idle' }));
  ipcMain.handle('update:check', () => true);
  ipcMain.handle('update:download', () => true);
  ipcMain.handle('update:install', () => true);
  ipcMain.handle('win:action', () => { });
  ipcMain.handle('dock:state', () => null);

  const win = new BrowserWindow({
    width: 420, height: 840, frame: false, transparent: true, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(600);
  win.webContents.send('data:update', snap);
  await wait(300);
  await win.webContents.executeJavaScript(`document.querySelector('#bottombar button[data-v="vLimits"]').click()`);
  await wait(500);
  const out = path.join(__dirname, '..', 'shot-out', 'antigravity.png');
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('[agy-shot] saved', out);
  app.exit(0);
});
