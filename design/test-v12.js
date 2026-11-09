'use strict';
/* design/test-v12.js — v1.2 专项回归：月历 / 轮播 / 设置钳制 / OTA 横幅 / 导出 / 主题
   用 sendInputEvent 走真实点击；IPC 挂最小 mock（含 store.js 同一套白名单语义）。
   运行：env -u ELECTRON_RUN_AS_NODE npx electron design/test-v12.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createStore } = require('../lib/store.js');
const { demoSnapshot } = require('../providers/index.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-v12-'));
const csvPath = path.join(tmpDir, 'usage.csv');

app.whenReady().then(async () => {
  const store = createStore(tmpDir);
  const settings = store.raw();
  let checkCalls = 0, exportCalls = 0, refreshCalls = 0;

  const sendSnap = () => {
    const d = demoSnapshot();
    return { snapshot: d, trending: { items: [{ repo: 'a/b', desc: '演示', stars: '1.2k' }] }, at: Date.now() };
  };

  ipcMain.handle('settings:get', () => store.publicView());
  ipcMain.handle('settings:update', (_e, patch) => {
    const next = {};
    for (const k of Object.keys(patch || {})) {
      if (['docked', 'dockX', 'winPos', 'updSha512', '__proto__'].includes(k)) continue;
      next[k] = patch[k];
    }
    Object.assign(settings, next);
    store.setInternal(next);
    return store.publicView();
  });
  ipcMain.handle('data:refresh', () => { refreshCalls++; });
  ipcMain.handle('data:export', () => { exportCalls++; return { ok: true, path: csvPath, rows: 30 }; });
  ipcMain.handle('ext:open', () => true);
  ipcMain.handle('update:state', () => ({ type: 'idle' }));
  ipcMain.handle('update:check', () => { checkCalls++; return true; });
  ipcMain.handle('update:download', () => true);
  ipcMain.handle('update:install', () => true);

  const win = new BrowserWindow({
    width: 420, height: 840, frame: false, transparent: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, spellcheck: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(700);
  win.webContents.send('data:update', sendSnap());
  await wait(400);

  const js = code => win.webContents.executeJavaScript(code);
  const results = [];
  const check = (name, ok, detail) => results.push(`${name}: ${ok ? 'PASS' : 'FAIL'}(${detail})`);
  const clickAt = (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const clickSel = async (sel) => {
    const p = await js(`(() => { const b=document.querySelector(${JSON.stringify(sel)}); if(!b) return null;
      b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
    if (!p) return false;
    await wait(100);
    const p2 = await js(`(() => { const b=document.querySelector(${JSON.stringify(sel)}); const r=b.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
    clickAt(p2.x, p2.y);
    await wait(220);
    return true;
  };

  /* ① 月历恒 6 行 42 格 */
  const nCells = await js(`document.querySelectorAll('#calGrid .d').length`);
  check('月历42格', nCells === 42, nCells);

  /* ② 月度小结有真实数字 */
  const sum = await js(`document.getElementById('calSum').textContent`);
  check('月度小结', /本月\s*\S/.test(sum) && !sum.includes('—'), sum.slice(0, 48));

  /* ②b 近 7 日趋势：7 根柱 + 环比文案 */
  const mt = await js(`JSON.stringify({n:document.querySelectorAll('#miniTrend svg rect').length,f:document.querySelector('#miniTrend .mt-f').textContent,d:document.querySelector('#miniTrend .mt-d').textContent})`);
  const mtv = JSON.parse(mt);
  check('近7日趋势', mtv.n === 7 && /合计/.test(mtv.f) && /较前 7 日/.test(mtv.d), mt);

  /* ③ 翻月高度不变 + 标题变 */
  const h0 = await js(`document.getElementById('calCard').offsetHeight`);
  await clickSel('#calPrev');
  const h1 = await js(`document.getElementById('calCard').offsetHeight`);
  const title = await js(`document.getElementById('calTitle').textContent`);
  check('翻月不跳高', h0 === h1, `${h0}->${h1} / ${title}`);
  await clickSel('#calNext');

  /* ④ 悬停浮层（事件委托） */
  const hover = await js(`(() => {
    const c = document.querySelector('#calGrid .d.has:not(.future)');
    if (!c) return 'no-cell';
    c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const t = document.getElementById('calTip');
    return t.classList.contains('show') && /tokens/.test(t.textContent) ? 'ok' : 'fail';
  })()`);
  check('悬停浮层', hover === 'ok', hover);

  /* ⑤ 点击钉住 → 再点关闭 */
  const cell = await js(`(() => { const c=document.querySelector('#calGrid .d.has:not(.future)'); if(!c) return null;
    const r=c.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),ymd:c.dataset.ymd}; })()`);
  if (cell) {
    clickAt(cell.x, cell.y); await wait(150);
    const pinned = await js(`document.getElementById('calTip').classList.contains('pinned') && document.getElementById('calTip').classList.contains('show')`);
    check('点击钉住', pinned, cell.ymd);
    clickAt(cell.x, cell.y); await wait(150);
    const closed = await js(`!document.getElementById('calTip').classList.contains('show')`);
    check('再点关闭', closed, 'tip hidden');
  } else { check('点击钉住', false, 'no-cell'); check('再点关闭', false, 'no-cell'); }

  /* ⑥ 数据刷新后陈旧浮层不残留、状态栏带新鲜度 */
  await js(`document.querySelector('#calGrid .d.has:not(.future)').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
  win.webContents.send('data:update', sendSnap());
  await wait(250);
  const stale = await js(`!document.getElementById('calTip').classList.contains('show')`);
  check('刷新清浮层', stale, 'cleared');
  const fresh = await js(`document.getElementById('stateTxt').textContent`);
  check('刷新时间', /刷新/.test(fresh), fresh);

  /* ⑦ OTA：available 出横幅 → up-to-date 收横幅；连点检查只发一次 */
  win.webContents.send('update:state', { type: 'available', version: '9.9.9', current: '1.2.0' });
  await wait(120);
  const bannerOn = await js(`document.getElementById('updateBanner').classList.contains('show')`);
  check('新版本横幅', bannerOn, String(bannerOn));
  win.webContents.send('update:state', { type: 'up-to-date', current: '1.2.0' });
  await wait(120);
  const bannerOff = await js(`!document.getElementById('updateBanner').classList.contains('show')`);
  check('最新收横幅', bannerOff, String(bannerOff));
  await clickSel('#bottombar button[data-v="vSettings"]');
  await clickSel('#btnCheckUpdate');
  await clickSel('#btnCheckUpdate');
  check('连点不重复检查', checkCalls === 1, 'calls=' + checkCalls);

  /* ⑧ 设置数值钳制 + 主题跟随系统 + 导出 CSV */
  await js(`(() => { document.getElementById('inRotate').value='-5'; document.getElementById('inRefresh').value='99999';
    document.getElementById('inTheme').value='system'; document.getElementById('inAlertPct').value='999'; })()`);
  await clickSel('#btnSaveAppearance');
  const vals = await js(`JSON.stringify({r:document.getElementById('inRotate').value,f:document.getElementById('inRefresh').value,t:document.getElementById('inTheme').value})`);
  const v = JSON.parse(vals);
  check('输入钳制', v.r === '3' && v.f === '1440', vals);
  win.webContents.send('theme:system', { dark: true });
  await wait(120);
  const dark = await js(`document.body.classList.contains('dark')`);
  check('跟随系统主题', dark && v.t === 'system', `dark=${dark}`);
  win.webContents.send('theme:system', { dark: false });
  await wait(100);

  await clickSel('#btnSaveAlert');
  const alertPct = await js(`document.getElementById('inAlertPct').value`);
  check('预警阈值钳制', alertPct === '50', alertPct);
  await clickSel('#btnExportCsv');
  const expHint = await js(`document.getElementById('exportHint').textContent`);
  check('导出CSV', exportCalls === 1 && /已导出/.test(expHint), expHint.slice(0, 50));

  /* ⑨ 隐藏视图不重绘：切到设置页后给首页打标记，再推一帧数据 */
  await js(`document.getElementById('calSum').innerHTML += '|MARK'`);
  win.webContents.send('data:update', sendSnap());
  await wait(200);
  const kept = await js(`document.getElementById('calSum').textContent.includes('|MARK')`);
  check('隐藏视图不重绘', kept, String(kept));
  await clickSel('#bottombar button[data-v="vHome"]');
  const redrawn = await js(`!document.getElementById('calSum').textContent.includes('|MARK')`);
  check('切回补绘', redrawn, String(redrawn));

  console.log('[v12-test]', results.join(' | '));
  const allOk = results.every(r => r.includes('PASS'));
  console.log('[v12-test]', allOk ? 'ALL PASS' : 'HAS FAIL', `(refreshCalls=${refreshCalls})`);
  app.exit(allOk ? 0 : 1);
});
