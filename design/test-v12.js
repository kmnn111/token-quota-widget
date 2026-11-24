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

  /* ⑧b Google AI 数据源：类型切换出专属表单、添加进清单、端口校验 */
  await js(`(() => { const s=document.getElementById('inSrcType'); s.value='antigravity'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await wait(120);
  const agyForm = await js(`(() => { const a=document.getElementById('frmAntigravity'); const m=document.getElementById('frmMimo'); const c=document.getElementById('frmCustom');
    return getComputedStyle(a).display!=='none' && getComputedStyle(m).display==='none' && getComputedStyle(c).display==='none'; })()`);
  check('AG 类型切表单', agyForm, String(agyForm));
  /* 非法端口拦截 */
  await js(`document.getElementById('inAgyPort').value='99999'`);
  await clickSel('#btnAddSrc');
  const agyReject = await js(`JSON.stringify(settings.providers||[])`);
  check('AG 非法端口拦截', !JSON.parse(agyReject).some(p => p.type === 'antigravity'), agyReject.slice(0, 60));
  /* 合法添加（留空端口 = 自动发现） */
  await js(`document.getElementById('inAgyPort').value=''`);
  await clickSel('#btnAddSrc');
  const agyAdded = await js(`JSON.stringify(settings.providers||[])`);
  const agyList = JSON.parse(agyAdded).filter(p => p.type === 'antigravity');
  check('AG 添加数据源', agyList.length === 1 && !agyList[0].port, agyAdded.slice(0, 90));
  const agyTag = await js(`(() => { const el=[...document.querySelectorAll('#srcList .src-item')].find(x=>x.textContent.includes('Google AI')); return el ? el.querySelector('.src-type').className : ''; })()`);
  check('AG 清单标签', /t-antigravity/.test(agyTag), agyTag);
  const agyLogo = await js(`(() => { const l=window.logoFor('Google AI'); return JSON.stringify({display:l.display, brand:l.brand, mark:/<path/.test(l.svg)}); })()`);
  const logoInfo = JSON.parse(agyLogo);
  check('Google AI 星标图标', logoInfo.display === 'Google AI' && logoInfo.brand === '#8E75B2' && logoInfo.mark, agyLogo);
  /* 小窗切换：幽灵层出现后自动清理，不堆叠（测试环境默认 reduce-motion，临时关掉验证动画分支） */
  await js(`window.__origMM=window.matchMedia; window.matchMedia=q=>q.includes('prefers-reduced-motion')?{matches:false}:window.__origMM(q); true`);
  await js(`(() => { const d=document.querySelectorAll('#pPager i'); if(d[1]) d[1].click(); })()`);
  const ghostNow = await js(`document.querySelectorAll('.pstroke.ghost').length`);
  /* 隐藏窗口的 WAAPI 不推进，下一帧数据刷新会走 paintPill 的清理路径 */
  win.webContents.send('data:update', sendSnap());
  await wait(250);
  const ghostAfter = await js(`document.querySelectorAll('.pstroke.ghost').length`);
  const motion = await js(`JSON.stringify({chip:document.getElementById('pChip').textContent, dots:document.querySelectorAll('#pPager i').length})`);
  await js(`window.matchMedia=window.__origMM; delete window.__origMM`);
  check('小窗平滑动效', ghostNow === 1 && ghostAfter === 0, `${ghostNow}/${ghostAfter} ${motion}`);
  /* 订阅会员源低余量：数字照常显示，但不进「告急」语义 */
  const lowSnap = { snapshot: { providers: [{ id: 'agy-low', type: 'antigravity', name: 'Google AI', color: '#8E75B2', status: 'ok', source: 'antigravity-local', plan: 'Google AI Pro', windows: [{ label: 'AI Credits · 本月', used: 950, limit: 1000, leftPct: 5, unit: 'credits', resetAt: null, resetType: 'monthly' }], balance: null }], usage: { day: 0, month: 0, total: 0, costDay: '', costMonth: '', perDay: {}, perDayInfo: {}, tools: [], sessions: [] }, at: Date.now() }, trending: { items: [] }, at: Date.now() };
  win.webContents.send('data:update', lowSnap);
  await wait(350);
  const subWarn = await js(`JSON.stringify({ chip:document.getElementById('pChip').classList.contains('warn'), ring:document.getElementById('pRingFg').style.stroke, state:document.getElementById('stateTxt').textContent, bar:[...document.querySelectorAll('#pinBody .bar')].map(x=>x.className) })`);
  const sw = JSON.parse(subWarn);
  check('Google AI 低余量不告急', !sw.chip && !/var\(--warn\)/.test(sw.ring) && !/有额度临界/.test(sw.state) && !sw.bar.some(c => /warn|danger/.test(c)), subWarn);
  win.webContents.send('data:update', sendSnap());
  await wait(250);
  /* 删掉，恢复空清单不影响后续测试 */
  await js(`(() => { const el=[...document.querySelectorAll('#srcList .src-item')].find(x=>x.textContent.includes('Google AI')); if(el) el.querySelector('[data-act=del]').click(); })()`);
  await wait(300);

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
