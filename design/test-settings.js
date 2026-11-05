'use strict';
/* design/test-settings.js — 设置页数据源真实点击回归：
   多条目添加 → 计数/清单出现 → 编辑态 → 删除单条 → 凭据打码与保留。
   用 webContents.sendInputEvent 走真实点击命中链路；IPC 挂真 store.js + mergeProviders。
   运行：env -u ELECTRON_RUN_AS_NODE npx electron design/test-settings.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createStore, mergeProviders } = require('../lib/store.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));

app.whenReady().then(async () => {
  const store = createStore(tmpDir);
  const settings = store.raw();

  /* 最小 IPC：与 main.js 同一套 store / 深合并 */
  ipcMain.handle('settings:get', () => store.publicView());
  ipcMain.handle('settings:update', (_e, patch) => {
    if (Array.isArray(patch.providers)) patch.providers = mergeProviders(settings.providers, patch.providers);
    const next = {};
    for (const k of Object.keys(patch)) {
      if (['docked', 'dockX', 'winPos', 'edgeDock'].includes(k)) continue;
      next[k] = patch[k];
    }
    Object.assign(settings, next);
    store.setInternal(next);
    return store.publicView();
  });
  ipcMain.handle('data:refresh', () => { });
  ipcMain.handle('ext:open', () => true);

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
  const clickSel = async (sel) => {
    const p = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector(${JSON.stringify(sel)});
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!p) return false;
    await new Promise(r => setTimeout(r, 120));
    const p2 = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector(${JSON.stringify(sel)});
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);   /* 滚动后重取坐标 */
    clickAt(p2.x, p2.y);
    await new Promise(r => setTimeout(r, 300));
    return true;
  };
  const js = (code) => win.webContents.executeJavaScript(code);
  const results = [];
  const check = (name, ok, detail) => results.push(`${name}: ${ok ? 'PASS' : 'FAIL'}(${detail})`);

  /* 进设置页 */
  await clickSel('#bottombar button[data-v="vSettings"]');

  /* ① 添加 MiMo 账号 1 */
  await js(`(() => {
    document.getElementById('inSrcType').value = 'mimo';
    document.getElementById('inSrcType').dispatchEvent(new Event('change'));
    document.getElementById('inMimoKey').value = 'tp-key-one';
  })()`);
  await clickSel('#btnAddSrc');
  check('添加MiMo-1', await js(`document.getElementById('srcCount').textContent`) === '已添加 1 个',
    await js(`document.getElementById('srcCount').textContent`));

  /* ② 添加 MiMo 账号 2（多账号） */
  await js(`document.getElementById('inMimoKey').value = 'tp-key-two'`);
  await clickSel('#btnAddSrc');
  const c2 = await js(`document.getElementById('srcCount').textContent`);
  check('添加MiMo-2', c2 === '已添加 2 个', c2);
  check('清单两行', await js(`document.querySelectorAll('#srcList .src-item').length`) === 2,
    await js(`document.querySelectorAll('#srcList .src-item').length`));

  /* ③ 添加中转站（custom） */
  await js(`(() => {
    document.getElementById('inSrcType').value = 'custom';
    document.getElementById('inSrcType').dispatchEvent(new Event('change'));
    document.getElementById('inCustomName').value = '测试中转站';
    document.getElementById('inCustomUrl').value = 'https://gw.example.com/api/usage';
    document.getElementById('inCustomToken').value = 'sk-secret-token';
  })()`);
  await clickSel('#btnAddSrc');
  const c3 = await js(`document.getElementById('srcCount').textContent`);
  check('添加中转站', c3 === '已添加 3 个', c3);

  /* ④ 编辑态：点第一行「编辑」→ 按钮变保存修改 + 取消出现 */
  await clickSel('#srcList .src-item:nth-child(1) .src-edit');
  const btnTxt = await js(`document.getElementById('btnAddSrc').textContent`);
  const cancelShown = await js(`!document.getElementById('btnCancelEdit').hidden`);
  check('编辑态', btnTxt === '保存修改' && cancelShown, btnTxt);

  /* ⑤ 取消编辑 */
  await clickSel('#btnCancelEdit');
  check('取消编辑', await js(`document.getElementById('btnAddSrc').textContent`) === '添加',
    await js(`document.getElementById('btnAddSrc').textContent`));

  /* ⑥ 删除中间一条（MiMo-2） */
  await clickSel('#srcList .src-item:nth-child(2) .src-del');
  const c6 = await js(`document.getElementById('srcCount').textContent`);
  check('删除单条', c6 === '已添加 2 个', c6);

  /* ⑦ 落盘核验：凭据真值保留、token 不以打码值落盘、无 hasXxx 标记 */
  const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
  const okKey = saved.providers.some(p => p.apiKey === 'tp-key-one') && !saved.providers.some(p => p.apiKey === 'tp-key-two');
  const okToken = saved.providers.some(p => p.token === 'sk-secret-token');
  const okClean = saved.providers.every(p => !('hasApiKey' in p) && !('hasToken' in p) && !/^•+$/.test(String(p.apiKey || '')));
  check('凭据真值落盘', okKey, JSON.stringify(saved.providers.map(p => ({ id: p.id, key: p.apiKey, tok: p.token }))));
  check('token真值落盘', okToken, okToken ? 'sk-secret-token' : 'missing');
  check('无打码/标记残留', okClean, okClean ? 'clean' : 'dirty');

  /* ⑧ 渲染层回读必须打码 */
  const pub = await js(`window.quota.getSettings().then(s => JSON.stringify(s.providers.map(p => ({ a: p.apiKey, t: p.token, ha: p.hasApiKey, ht: p.hasToken }))))`);
  const pubArr = JSON.parse(pub);
  const masked = pubArr.every(p => p.a !== 'tp-key-one' && p.t !== 'sk-secret-token') && pubArr.some(p => p.ha === true);
  check('回传打码', masked, pub.slice(0, 80));

  console.log('[settings-test]', results.join(' | '));
  console.log('[settings-test]', results.every(r => r.includes('PASS')) ? 'ALL PASS' : 'HAS FAIL');
  app.exit(0);
});
