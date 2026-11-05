'use strict';
/**
 * 额度窗 — Windows 桌面 AI Token 额度仪表盘（主进程）
 * 无边框透明玻璃 · 大窗 480×920 ↔ 吸顶胶囊 348×64 clip-path 形变 · 托盘 · 位置记忆
 *
 * 「显示桌面」保活三保险（照搬天气台实战结论）：
 *  ① docked 态拦截系统 minimize（Win+D / Win+M / 任务栏小竖条），showInactive 原地拉回不抢焦点；
 *  ② 置顶开着：topmost('screen-saver') 级，天然免疫壁纸层跃升；
 *  ③ 置顶关着（桌面部件语义）：koffi 每 100ms 把小窗钉在壁纸层 WorkerW 正上方 ——
 *     Win+D 壁纸跃升时小窗跟着浮上来，全程不压任何程序窗口。
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const SHOT_MODE = process.argv.includes('--shot') || process.argv.includes('--shot-dock');
if (SHOT_MODE) {
  try { app.setPath('userData', app.getPath('userData') + '-shot'); } catch (e) { }
}

const { isAllowedExtUrl } = require('./ext-guard.js');
const { createStore } = require('./lib/store.js');
const { createHub } = require('./providers/index.js');

/* ---------------- 窗口几何常量（一切纠偏的唯一锚点） ---------------- */
const DESIGN_W = 420, DESIGN_H = 840;
const PILL_W = 248, PILL_H = 64;   // 与天气台 / 云上会议同规格
const SNAP_IN = 26, SNAP_OUT = 90;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

let win = null;
let tray = null;
let settings = null;
let store = null;
let hub = null;
let dockExpanded = false;
let dockTimer = null;
let hoverArmed = true;
let hoverPoll = null;
let programmatic = 0;
let baseSize = { w: DESIGN_W, h: DESIGN_H };

/* ---------------- 形状 / bounds ---------------- */
function setBoundsSafe(r) {
  if (!win || win.isDestroyed()) return;
  programmatic = Date.now();
  win.setBounds(r);
}
function pillShapeRect() {
  return [{ x: Math.round((baseSize.w - PILL_W) / 2), y: 0, width: PILL_W, height: PILL_H }];
}
function setShapePill() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape(pillShapeRect()); } catch (e) { }
}
function setShapeFull() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape([{ x: 0, y: 0, width: baseSize.w, height: baseSize.h }]); } catch (e) { }
}

/* ---------------- 壁纸层胶水（koffi / user32） ---------------- */
let glueTimer = null, glueU32 = null;
function glueInit() {
  if (glueU32) return glueU32;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    glueU32 = {
      getDesktop: u.func('void *GetDesktopWindow()'),
      getWindow: u.func('void *GetWindow(void *h, uint cmd)'),
      getClassName: u.func('int GetClassNameW(void *h, uint16 *buf, int max)'),
      getRect: u.func('bool GetWindowRect(void *h, void *rect)'),
      isVisible: u.func('bool IsWindowVisible(void *h)'),
      setPos: u.func('bool SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint flags)')
    };
  } catch (e) { glueU32 = null; }
  return glueU32;
}
/* 全屏 WorkerW（class=WorkerW、w>1200、h>700）。每 tick 重扫不缓存句柄：
   跃升=换位+变形，缓存必失手；自顶向下扫、上限 2000。可见者取最靠上（跃升态），否则最靠下（常态）。 */
function glueWallpaper() {
  const A = glueInit(); if (!A) return null;
  let p = A.getWindow(A.getDesktop(), 5), n = 0;
  const seen = new Set();
  const nameBuf = Buffer.alloc(256);
  let visBest = null, hidBest = null;
  while (p && p !== 0n && n < 2000) {
    const s = String(p); if (seen.has(s)) break; seen.add(s);
    const len = A.getClassName(p, nameBuf, 128);
    if (nameBuf.subarray(0, len * 2).toString('utf16le') === 'WorkerW') {
      const r = Buffer.alloc(16); A.getRect(p, r);
      const w = r.readInt32LE(8) - r.readInt32LE(0), h = r.readInt32LE(12) - r.readInt32LE(4);
      if (w > 1200 && h > 700) {
        if (A.isVisible(p)) { if (!visBest) visBest = p; } else hidBest = p;
      }
    }
    p = A.getWindow(p, 2); n++;
  }
  return visBest || hidBest;
}
function glueTick() {
  const A = glueInit(); if (!A || !win || win.isDestroyed()) return;
  const W = glueWallpaper(); if (!W) return;
  const wallUp = A.isVisible(W);
  if (!wallUp && (win.isFocused() || dockExpanded)) return; // 常态放行交互置前
  const hw = win.getNativeWindowHandle().readBigUInt64LE(0);
  if (A.getWindow(hw, 2) !== W) {
    const anchor = A.getWindow(W, 3) || 0n;
    A.setPos(hw, anchor, 0, 0, 0, 0, 0x1B); // NOSIZE|NOMOVE|NOSENDCHANGING|NOACTIVATE
  }
}
function setGlue(on) {
  if (on) {
    if (!glueTimer) glueTimer = setInterval(glueTick, 100);
    glueTick();
  } else if (glueTimer) { clearInterval(glueTimer); glueTimer = null; }
}
function applyTopmost() {
  if (!win || win.isDestroyed()) return;
  try {
    if (settings.docked && settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'screen-saver');
      setGlue(false);
    } else {
      win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating');
      setGlue(!!settings.docked && !settings.alwaysOnTop);
    }
  } catch (e) { }
}

/* ---------------- 吸顶 / 展开 ---------------- */
function sendDockState() {
  if (win && !win.isDestroyed()) win.webContents.send('dock:state', { docked: !!settings.docked, expanded: dockExpanded });
}
function handleDockHover(inside) {
  if (!win || win.isDestroyed() || !settings.docked || settings.edgeDock === false) return;
  if (SHOT_MODE) return;
  if (inside) {
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    if (hoverArmed && !dockExpanded) expandDock();
  } else {
    hoverArmed = true;
    if (dockExpanded && !dockTimer) {
      dockTimer = setTimeout(() => {
        dockTimer = null;
        if (win && !win.isDestroyed() && settings.docked && dockExpanded) collapseDock();
      }, 450);
    }
  }
}
function ensureHoverPoll() {
  if (hoverPoll) return;
  hoverPoll = setInterval(() => {
    if (!win || win.isDestroyed() || !settings.docked || settings.edgeDock === false) return;
    if (!win.isVisible()) return;
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    const z = dockExpanded ? b : (r => ({ x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height }))(pillShapeRect()[0]);
    const inZone = p.x >= z.x && p.x <= z.x + z.width && p.y >= z.y && p.y <= z.y + z.height;
    if (!dockExpanded && inZone && p.x < z.x + 46) return; // 左侧抓手只用于拖拽
    handleDockHover(inZone);
  }, 260);
}
function stopHoverPoll() {
  clearInterval(hoverPoll); hoverPoll = null;
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
}
function dockWindow() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  hoverArmed = false;
  settings.docked = true; settings.dockX = px;
  store.setInternal({ docked: true, dockX: px });
  setBoundsSafe({ x: px - Math.round((baseSize.w - PILL_W) / 2), y: wa.y, width: baseSize.w, height: baseSize.h });
  setShapePill();
  applyTopmost();
  sendDockState();
  ensureHoverPoll();
}
function undockWindow() {
  if (!win || win.isDestroyed()) return;
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  settings.docked = false;
  const b = win.getBounds();
  store.setInternal({ docked: false, winPos: { x: b.x, y: b.y } });
  setShapeFull();
  applyTopmost();
  sendDockState();
  stopHoverPoll();
}
function expandDock() {
  if (!win || win.isDestroyed()) return;
  dockExpanded = true;
  setShapeFull();
  sendDockState();
  ensureHoverPoll();
}
function collapseDock() {
  if (!win || win.isDestroyed()) return;
  dockExpanded = false;
  hoverArmed = false;
  sendDockState();
  setTimeout(() => {
    if (!win || win.isDestroyed() || !settings.docked || dockExpanded) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
    const nx = px - Math.round((baseSize.w - PILL_W) / 2);
    if (nx !== b.x || b.y !== wa.y) setBoundsSafe({ x: nx, y: wa.y, width: baseSize.w, height: baseSize.h });
    if (px !== settings.dockX) { settings.dockX = px; store.setInternal({ dockX: px }); }
    setShapePill();
  }, 260);
  ensureHoverPoll();
}
function checkSnap() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) return;
  if (Date.now() - programmatic < 600) return;
  if (settings.edgeDock === false) {
    if (settings.docked) undockWindow();
    return;
  }
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (!settings.docked) {
    if (b.y - wa.y <= SNAP_IN) dockWindow();
  } else if (b.y - wa.y > SNAP_OUT) {
    undockWindow();
  } else if (!dockExpanded) {
    dockWindow();
  }
}

/* ---------------- 托盘 ---------------- */
function buildTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (img.isEmpty()) { /* 无图时用 1px 透明兜底，托盘仍可右键 */ }
  tray = new Tray(img);
  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: settings.docked ? '展开完整仪表盘' : '收起为吸顶小窗', click: () => (settings.docked ? undockWindow() : dockWindow()) },
      { label: '立即刷新额度', click: () => hub && hub.refreshNow() },
      { type: 'separator' },
      { label: '置顶', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (m) => { store.setInternal({ alwaysOnTop: m.checked }); settings.alwaysOnTop = m.checked; applyTopmost(); } },
      { label: '顶部吸附', type: 'checkbox', checked: settings.edgeDock !== false, click: (m) => { store.setInternal({ edgeDock: m.checked }); settings.edgeDock = m.checked; if (!m.checked && settings.docked) undockWindow(); } },
      { type: 'separator' },
      { label: '退出', click: () => { tray = null; app.quit(); } }
    ]));
    tray.setToolTip('额度窗 · ' + (settings.docked ? '吸顶小窗' : '仪表盘'));
  };
  rebuild();
  tray.on('double-click', () => (settings.docked ? undockWindow() : (win && win.isVisible() ? win.focus() : win && win.show())));
  return { rebuild };
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  let x, y;
  const startDocked = !!settings.docked && settings.edgeDock !== false;
  if (startDocked) {
    const px = Number.isFinite(settings.dockX) ? settings.dockX : wa.x + wa.width - PILL_W - 36;
    x = clamp(px - Math.round((baseSize.w - PILL_W) / 2), wa.x, wa.x + wa.width - baseSize.w);
    y = wa.y;
  } else if (settings.winPos && Number.isFinite(settings.winPos.x)) {
    x = settings.winPos.x; y = settings.winPos.y;
  } else {
    x = wa.x + wa.width - baseSize.w - 36; y = wa.y + wa.height - baseSize.h - 24;
  }
  const onScreen = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return x < a.x + a.width && x + baseSize.w > a.x && y < a.y + a.height && y + baseSize.h > a.y;
  });
  if (!onScreen) { x = wa.x + wa.width - baseSize.w - 36; y = wa.y + wa.height - baseSize.h - 24; }

  win = new BrowserWindow({
    x: Math.round(x), y: Math.round(y),
    width: baseSize.w, height: baseSize.h,
    frame: false,
    transparent: true,
    thickFrame: false,   // 关掉 Win11 DWM 边框/圆角，彻底无边框沉浸
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: !!settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: '额度窗',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  /* 导航防护：单页本地应用，禁止一切外跳/开窗（跳转走 ext:open 白名单） */
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());

  applyTopmost();

  /* 保险①：docked 态拦截系统最小化（Win+D / Win+M / 显示桌面）原地拉回 */
  const undoMinimize = () => {
    if (!win || win.isDestroyed() || !settings.docked) return;
    if (!win.isMinimized()) return;
    try { win.showInactive(); } catch (e) { try { win.restore(); } catch (e2) { } }
    try { win.moveTop(); } catch (e3) { }
    try { applyTopmost(); } catch (e4) { }
    if (settings.docked && !dockExpanded) setShapePill();
  };
  win.on('minimize', () => {
    if (!settings.docked) return; // 大窗态保持系统正常行为
    setImmediate(undoMinimize);
    setTimeout(undoMinimize, 40);
    setTimeout(undoMinimize, 250);
  });
  win.on('closed', () => setGlue(false));

  if (SHOT_MODE) { try { win.webContents.session.clearCache().catch(() => { }); } catch (e) { } }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    sendDockState();
    if (settings.docked) setShapePill();
  });
  if (startDocked) { hoverArmed = true; ensureHoverPoll(); }
  if (!SHOT_MODE && !startDocked) setTimeout(checkSnap, 1200);
  win.on('moved', () => { /* 拖拽结束（moved 在拖放时触发） */ checkSnap(); });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  if (SHOT_MODE) {
    const fsx = require('fs');
    const outDir = path.join(__dirname, 'shot-out');
    try { fsx.mkdirSync(outDir, { recursive: true }); } catch (e) { }
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const take = (name) => win.webContents.capturePage().then(img => {
      fsx.writeFileSync(path.join(outDir, name), img.toPNG());
      console.log('[shot] saved', name);
    }).catch(e => console.log('[shot] fail', name, e.message));
    const js = code => win.webContents.executeJavaScript(code).catch(() => { });
    setTimeout(async () => {
      store.setInternal({ theme: 'light' });  // 截图恒用白天玻璃
      await win.webContents.executeJavaScript(`document.body.classList.remove('dark')`).catch(() => { });
      undockWindow();                       // 强制展开，避免上次吸顶记忆污染首图
      await wait(500);
      await take('main.png');
      await js(`document.querySelector('#bottombar button[data-v="vLimits"]').click()`);
      await wait(400);
      await take('limits.png');
      await js(`document.querySelector('#bottombar button[data-v="vHome"]').click()`);
      await wait(300);
      dockWindow();                         // 吸顶态
      await wait(800);
      await take('dock.png');
      app.exit(0);
    }, 3400);
  }
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('settings:get', () => store.publicView());

  ipcMain.handle('settings:update', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return store.publicView();
    /* providers 深合并：凭据字段是打码值时保留原值，绝不让 ••• 覆盖真实 Cookie/Key */
    if (Array.isArray(patch.providers)) {
      const old = new Map((settings.providers || []).map(p => [p.id, p]));
      patch.providers = patch.providers.map(p => {
        const prev = old.get(p.id);
        if (!prev) return p;
        const merged = Object.assign({}, p);
        for (const secret of ['cookie', 'apiKey', 'token']) {
          if (!merged[secret] || /^•+$/.test(String(merged[secret]))) {
            merged[secret] = prev[secret] || '';
          }
        }
        return merged;
      });
    }
    const next = {};
    for (const k of Object.keys(patch)) {
      if (['docked', 'dockX', 'winPos', 'alwaysOnTop', 'edgeDock'].includes(k)) continue; // 几何态只由主进程写
      next[k] = patch[k];
    }
    Object.assign(settings, next);
    store.setInternal(next);
    if (patch.trendingRange && hub) hub.refreshTrending();
    return store.publicView();
  });

  ipcMain.on('win:drag', (_e, sx, sy) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const p = screen.getCursorScreenPoint();
    const nx = b.x + p.x - sx, ny = clamp(b.y + p.y - sy, wa.y - 0, wa.y + wa.height - PILL_H);
    setBoundsSafe({ x: nx, y: ny, width: baseSize.w, height: baseSize.h });
  });
  ipcMain.on('win:drag-end', () => checkSnap());
  ipcMain.on('win:drag-start', () => { if (dockExpanded) { dockExpanded = false; sendDockState(); } });

  ipcMain.on('dock:hover', (_e, inside) => handleDockHover(!!inside));

  ipcMain.on('win:action', (_e, act) => {
    if (act === 'quit') { tray = null; app.quit(); }
    else if (act === 'hide') win.hide();
    else if (act === 'show') win.show();
    else if (act === 'dock') { settings.docked ? undockWindow() : dockWindow(); }
  });

  ipcMain.handle('ext:open', (_e, url) => {
    if (!isAllowedExtUrl(url)) return false;
    shell.openExternal(String(url));
    return true;
  });

  ipcMain.handle('data:refresh', () => hub && hub.refreshNow());
}

/* ---------------- Win+D / 显示桌面 保活自检（--selftest） ----------------
   真实调用 explorer 的 ToggleDesktop（等价于按 Win+D / 点任务栏右下角），
   验证吸顶小窗在「置顶开」「置顶关（壁纸层胶水）」两种模式下都不被带走。 */
function runSelfTest() {
  const { execSync } = require('child_process');
  const toggle = () => {
    try {
      execSync('powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).ToggleDesktop()"', { timeout: 8000 });
    } catch (e) { console.log('[selftest] ToggleDesktop 调用失败', e.message); }
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const verdict = (label) => {
    const vis = win.isVisible();
    const min = win.isMinimized();
    const ok = vis && !min;
    console.log(`[selftest] ${label}: visible=${vis} minimized=${min} => ${ok ? 'PASS 小窗未被显示桌面带走' : 'FAIL'}`);
    return ok;
  };
  (async () => {
    const results = [];
    dockWindow();
    await sleep(600);
    for (const topmost of [true, false]) {
      settings.alwaysOnTop = topmost;
      applyTopmost();
      await sleep(400);
      toggle();                     // 模拟 Win+D / 显示桌面
      await sleep(900);
      results.push(verdict(topmost ? '置顶开（screen-saver 级 topmost）' : '置顶关（壁纸层 WorkerW 胶水）'));
      toggle();                     // 切回桌面，恢复现场
      await sleep(700);
    }
    settings.alwaysOnTop = true;
    applyTopmost();
    console.log('[selftest] 汇总:', results.every(x => x) ? 'ALL PASS' : 'HAS FAIL');
    app.exit(0);
  })();
}

/* ---------------- 启动 ---------------- */
app.whenReady().then(() => {
  store = createStore(app.getPath('userData'));
  settings = store.raw();
  if (!fs.existsSync(app.getPath('userData'))) fs.mkdirSync(app.getPath('userData'), { recursive: true });

  hub = createHub(settings, snap => {
    if (win && !win.isDestroyed()) win.webContents.send('data:update', snap);
  });
  hub.start();

  createWindow();
  registerIpc();
  buildTray();

  if (process.argv.includes('--selftest')) {
    try { app.setPath('userData', app.getPath('userData') + '-selftest'); } catch (e) { }
    setTimeout(runSelfTest, 2500);
  }

  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
});
app.on('before-quit', () => setGlue(false));
