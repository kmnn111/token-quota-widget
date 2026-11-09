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
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, nativeImage, Notification, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const SHOT_MODE = process.argv.includes('--shot') || process.argv.includes('--shot-dock');
const HOVER_TEST = process.argv.includes('--hover-test');
if (SHOT_MODE || HOVER_TEST) {
  /* 自检/截图用独立 userData，避免 dockWindow() 写脏用户真实的吸顶配置 */
  try { app.setPath('userData', app.getPath('userData') + (SHOT_MODE ? '-shot' : '-hovertest')); } catch (e) { }
}

const { isAllowedExtUrl } = require('./ext-guard.js');
const { createStore, mergeProviders, PUBLIC_KEYS } = require('./lib/store.js');
const { createHub } = require('./providers/index.js');

/* ---------------- 窗口几何常量（一切纠偏的唯一锚点） ---------------- */
const DESIGN_W = 420, DESIGN_H = 840;
const PILL_W = 280, PILL_H = 64;   // 吸顶胶囊（280 宽：文字|logo|环形图 三段舒展）
const SNAP_IN = 26, SNAP_OUT = 90;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

let win = null;
let tray = null;
let settings = null;
let store = null;
let hub = null;
let lastSnap = null;   // 最近一帧快照（页面就绪后补发，防启动竞态丢帧）
let dockExpanded = false;
let dockTimer = null;
let hoverArmed = true;
let hoverPoll = null;
let domHover = null;   // 渲染层上报的鼠标状态；非 null 表示 DOM 事件可用，坐标轮询让位
let programmatic = 0;
let baseSize = { w: DESIGN_W, h: DESIGN_H };
let refreshTrayMenu = () => { };   // 托盘菜单复建（设置变更后同步 checkbox）
let quotaAlertLog = null;          // 额度预警去重（落盘）：同一源同一额度窗同一天只提醒一次

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
  if (!win.isVisible() || win.isMinimized()) return;   // 隐藏时不做 100ms 窗口层扫描，省 CPU
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
/* 悬停展开主要由渲染层 DOM 事件驱动（mouseenter/mouseleave），不依赖屏幕坐标：
   坐标轮询在高 DPI 缩放 / 多显示器下 getCursorScreenPoint 与 getBounds 口径可能不一致，
   是「滑过小窗不展开」的历史根因；现仅作页面未上报事件时的向后兼容兜底。
   另外 edgeDock 只控制「拖到屏幕顶部自动吸附」，不该禁用已吸顶小窗的悬停展开。 */
function handleDockHover(inside, fromDom) {
  if (!win || win.isDestroyed() || !settings.docked) return;
  if (SHOT_MODE) return;
  if (inside) {
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    /* 真实 mouseenter = 用户明确把鼠标移到小窗上，直接武装，不必先移出一次 */
    if (fromDom) hoverArmed = true;
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
function onDomDockHover(inside) {
  domHover = !!inside;
  /* DOM 通道已接管：停掉坐标轮询，避免两套判定互相打架造成展开/收起抖动。
     注意只清 interval，不清 dockTimer（收起延时还要用）。 */
  if (hoverPoll) { clearInterval(hoverPoll); hoverPoll = null; }
  handleDockHover(!!inside, true);
}
function ensureHoverPoll() {
  if (hoverPoll || domHover !== null) return;   // DOM 事件可用时不再启动坐标轮询
  hoverPoll = setInterval(() => {
    if (!win || win.isDestroyed() || !settings.docked) return;
    if (!win.isVisible()) return;
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    const z = dockExpanded ? b : (r => ({ x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height }))(pillShapeRect()[0]);
    const inZone = p.x >= z.x && p.x <= z.x + z.width && p.y >= z.y && p.y <= z.y + z.height;
    if (!dockExpanded && inZone && p.x < z.x + 46) return; // 左侧抓手只用于拖拽
    handleDockHover(inZone, false);
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
  refreshTrayMenu = rebuild;   // 设置页/托盘任一入口改动后，另一处 checkbox 同步刷新
  tray.on('double-click', () => (settings.docked ? undockWindow() : (win && win.isVisible() ? win.focus() : win && win.show())));
  return { rebuild };
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  let x, y;
  /* 截图模式忽略持久化的吸顶态：否则上一轮结尾的 dockWindow() 会污染下一轮首图 */
  const startDocked = !SHOT_MODE && !!settings.docked && settings.edgeDock !== false;
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
    /* 桌面部件模式（不置顶）下不用 moveTop：避免瞬时压到别的程序窗口上 */
    if (settings.alwaysOnTop) { try { win.moveTop(); } catch (e3) { } }
    try { applyTopmost(); } catch (e4) { }
    if (settings.docked && !dockExpanded) setShapePill();
  };
  win.on('minimize', () => {
    if (!settings.docked) return; // 大窗态保持系统正常行为
    setImmediate(undoMinimize);
    setTimeout(undoMinimize, 40);
    setTimeout(undoMinimize, 250);
  });
  win.on('closed', () => { setGlue(false); if (hub) hub.stop(); });
  win.on('hide', () => { if (hub) hub.setPaused(true); });
  win.on('show', () => { if (hub) hub.setPaused(false); });

  if (SHOT_MODE) { try { win.webContents.session.clearCache().catch(() => { }); } catch (e) { } }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    sendDockState();
    if (settings.theme === 'system') pushSystemTheme();
    /* 启动竞态防护：hub 首帧可能在页面就绪前已广播（send 丢失），
       页面加载完成后补发最近一帧，避免界面长时间停在静态骨架 */
    if (lastSnap) win.webContents.send('data:update', lastSnap);
    /* 页面重载后 DOM 通道尚未上报，重置标记让坐标轮询先顶上 */
    domHover = null;
    if (settings.docked) {
      setShapePill();
      if (!SHOT_MODE) { hoverArmed = true; ensureHoverPoll(); }
    }
  });
  /* 只要处于吸顶态就启用悬停检测，不再依赖 startDocked（曾被 edgeDock 短路导致完全不检测） */
  if (settings.docked && !SHOT_MODE) { hoverArmed = true; ensureHoverPoll(); }
  if (!SHOT_MODE && !startDocked) setTimeout(checkSnap, 1200);
  win.on('moved', () => { /* 拖拽结束（moved 在拖放时触发） */ checkSnap(); });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  if (SHOT_MODE) {
    const fsx = require('fs');
    /* 打包后 asar 只读，截图落到用户图片目录；源码运行仍落仓库 shot-out/ */
    const outDir = app.isPackaged
      ? path.join(app.getPath('pictures') || app.getPath('temp'), '额度窗截图')
      : path.join(__dirname, 'shot-out');
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
      await js(`document.querySelector('#bottombar button[data-v="vSettings"]').click()`);
      await wait(400);
      await take('settings.png');
      await js(`document.getElementById('btnExportCsv').scrollIntoView({ block: 'center' })`);  // 数据与提醒卡
      await wait(300);
      await take('settings-data.png');
      await js(`document.querySelector('#vSettings').scrollTop = 9999`);   // 滚到底：软件更新卡
      await wait(300);
      await take('settings-update.png');
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
    /* 白名单而非黑名单：杜绝 __proto__ 之类任意键注入 settings / 原型污染 */
    const next = {};
    for (const k of Object.keys(patch)) {
      if (!PUBLIC_KEYS.has(k)) continue;
      if (k === 'providers') continue;   // 单独深合并
      next[k] = patch[k];
    }
    /* providers 深合并：凭据字段是打码值时保留原值，绝不让 ••• 覆盖真实 Cookie/Key */
    if (Array.isArray(patch.providers)) {
      next.providers = mergeProviders(settings.providers, patch.providers).slice(0, 30);
      /* 自定义端点只收 HTTP(S)，限长防误填整段文本 */
      next.providers = next.providers.map(p => {
        const q = Object.assign({}, p);
        if (q.url != null) { q.url = String(q.url).trim().slice(0, 500); if (q.url && !/^https?:\/\/[^\s]+$/i.test(q.url)) q.url = ''; }
        if (q.name != null) q.name = String(q.name).slice(0, 60);
        if (q.map != null && typeof q.map === 'object') {
          for (const mk of Object.keys(q.map)) q.map[mk] = String(q.map[mk]).slice(0, 120);
        }
        return q;
      });
    }
    /* 数值钳制：负数 / 超大值会让定时器疯转或永不刷新 */
    const clampNum = (v, lo, hi, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fb; };
    if ('refreshMinutes' in next) next.refreshMinutes = clampNum(next.refreshMinutes, 1, 1440, 5);
    if ('rotateSeconds' in next) next.rotateSeconds = clampNum(next.rotateSeconds, 3, 60, 5);
    if ('quotaAlertPct' in next) next.quotaAlertPct = clampNum(next.quotaAlertPct, 1, 50, 10);
    if ('quotaAlert' in next) next.quotaAlert = !!next.quotaAlert;
    if ('alwaysOnTop' in next) next.alwaysOnTop = !!next.alwaysOnTop;
    if ('theme' in next) next.theme = ['light', 'dark', 'system'].includes(String(next.theme)) ? String(next.theme) : 'light';
    if ('trendingRange' in next) next.trendingRange = String(next.trendingRange) === 'weekly' ? 'weekly' : 'daily';
    /* 更新源白名单校验：只收 HTTP(S)，防止 updateUrl 被劫持到恶意更新源 */
    if ('updateUrl' in next) {
      const u = String(next.updateUrl || '').trim().slice(0, 300);
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return store.publicView();
      next.updateUrl = u.replace(/\/+$/, '');
    }
    Object.assign(settings, next);
    store.setInternal(next);
    if ('alwaysOnTop' in next || 'edgeDock' in next) { applyTopmost(); refreshTrayMenu(); }
    if ('theme' in next && next.theme === 'system') pushSystemTheme();
    if ('trendingRange' in next && hub) hub.refreshTrending();
    return store.publicView();
  });

  let dragWatch = null;
  function stopDragWatch() { if (dragWatch) { clearInterval(dragWatch); dragWatch = null; } }
  ipcMain.on('win:drag', (_e, sx, sy) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const p = screen.getCursorScreenPoint();
    const nx = b.x + p.x - sx, ny = clamp(b.y + p.y - sy, wa.y - 0, wa.y + wa.height - PILL_H);
    setBoundsSafe({ x: nx, y: ny, width: baseSize.w, height: baseSize.h });
    /* 左键松开看门狗：光标甩出窗口、mouseup 丢失时也能正常收尾（不粘拖） */
    if (!dragWatch) {
      let lbtn = null;
      try { lbtn = require('koffi').load('user32.dll').func('GetAsyncKeyState', 'int', ['int']); } catch (e) { }
      if (!lbtn) return;
      dragWatch = setInterval(() => {
        if (lbtn(0x01) & 0x8000) return;   // 左键仍按下
        stopDragWatch();
        checkSnap();
      }, 120);
    }
  });
  ipcMain.on('win:drag-end', () => { stopDragWatch(); checkSnap(); });
  ipcMain.on('win:drag-start', () => { if (dockExpanded) { dockExpanded = false; sendDockState(); } });

  ipcMain.on('dock:hover', (_e, inside) => onDomDockHover(!!inside));

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

  /* 导出当月逐日用量 CSV（用户选路径，写入前生成内容，取消不落盘） */
  ipcMain.handle('data:export', async () => {
    try {
      const csv = buildUsageCsv(lastSnap);
      if (!csv) return { ok: false, message: '暂无本机用量数据可导出' };
      const now = new Date();
      const def = `额度窗用量_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.csv`;
      const r = await dialog.showSaveDialog(win, {
        title: '导出当月用量', defaultPath: path.join(app.getPath('documents') || app.getPath('home'), def),
        filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, csv, 'utf8');
      return { ok: true, path: r.filePath, rows: csv.trim().split('\r\n').length - 1 };
    } catch (e) { return { ok: false, message: String(e && e.message || e).slice(0, 120) }; }
  });

  /* OTA 在线更新 */
  ipcMain.handle('update:check', () => { checkForUpdates(true); return true; });
  ipcMain.handle('update:download', () => { startUpdateDownload(); return true; });
  ipcMain.handle('update:install', () => { installUpdate(); return true; });
  ipcMain.handle('update:state', () => updateState);
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

/* ---------------- 吸顶悬停展开自检（--hover-test） ----------------
   用真实 DOM 事件走 renderer → preload → IPC → 主进程全链路，
   覆盖「滑入展开 / 移开收起 / 可重复 / 关掉顶部吸附后仍可用」。 */
function runHoverTest() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const js = code => win.webContents.executeJavaScript(code).catch(() => null);
  const fire = type => js(`document.getElementById('frame').dispatchEvent(new MouseEvent('${type}', { bubbles: false, relatedTarget: null }))`);
  const results = [];
  const check = (label, ok, extra) => {
    console.log(`[hover-test] ${label}: ${ok ? 'PASS' : 'FAIL'}${extra ? ' ' + extra : ''}`);
    results.push(ok);
  };
  (async () => {
    dockWindow();
    await sleep(500);
    const domChannel = await js(`document.getElementById('frame').classList.contains('docked')`);
    check('吸顶态 + 渲染层已就位', domChannel === true, 'docked=' + domChannel);
    check('初始为小窗', dockExpanded === false);

    await fire('mouseenter');
    await sleep(350);
    check('滑过小窗变大窗', dockExpanded === true);

    await fire('mouseleave');
    await sleep(900);
    check('移开恢复小窗', dockExpanded === false);

    await fire('mouseenter');
    await sleep(350);
    check('再次滑入可重复展开', dockExpanded === true);

    /* 回归点：edgeDock（拖到顶部自动吸附开关）曾把悬停检测一刀切短路 */
    settings.edgeDock = false;
    await fire('mouseleave');
    await sleep(900);
    await fire('mouseenter');
    await sleep(350);
    check('顶部吸附关闭后悬停仍生效', dockExpanded === true);

    console.log('[hover-test] 汇总:', results.every(Boolean) ? 'ALL PASS' : 'HAS FAIL');
    app.exit(0);
  })();
}

/* ---------------- OTA 在线更新（照搬天气台实战机制） ----------------
   generic 更新源：dist 里的 latest.yml + 安装包 + .blockmap 一起传到 GitHub Releases，
   默认源指向 releases/latest/download。流程：启动 / 每 4 小时后台检查 → 发现新版本
   弹横幅提醒 → 用户点「立即更新」后台下载（带进度）→ 下载完成提示重启安装。
   防回环：「立即重启」时记下安装包 sha512，同一 offer（同 sha 热修重推）按已装跳过。 */
const DEFAULT_UPDATE_URL = 'https://github.com/kmnn111/token-quota-widget/releases/latest/download';
let autoUpdater = null;
let updateState = { type: 'idle' };
let updateTimer = null;
let checkWatchdog = null;  // 检查看门狗：网络异常时更新请求可能永远挂起，超时收场别让界面一直转圈
let pendingUpdateSha = ''; // 本次下载完成的安装包 sha512；用户确认安装时落盘为消费标记

function otaLog(...args) {
  console.log('[ota]', ...args);
  const logPath = process.argv.find(a => a.startsWith('--ota-log='));
  if (logPath || process.argv.includes('--shot-update')) {
    try {
      const p = logPath ? logPath.slice('--ota-log='.length) : path.join(app.getPath('userData'), 'ota-test.log');
      fs.appendFileSync(p, new Date().toISOString() + ' ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    } catch (e) { }
  }
}

function effectiveUpdateUrl() {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  const url = cli ? cli.slice('--update-url='.length) : (settings.updateUrl || DEFAULT_UPDATE_URL);
  return String(url || '').trim().replace(/\/+$/, '');
}

/* 系统推送通知：吸顶小窗看不到更新横幅，发现新版本 / 更新就绪时各推一次 */
const notifiedUpdate = { available: '', downloaded: '' };
function pushNotify(title, body) {
  try {
    if (SHOT_MODE || process.argv.includes('--shot-update') || !Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => {
      if (win && !win.isDestroyed()) {
        win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    n.show();
  } catch (e) { otaLog('notify failed', String(e)); }
}

/* 跟随系统主题：把系统深浅色推给渲染层（仅当设置里选了「跟随系统」时才应用） */
function pushSystemTheme() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('theme:system', { dark: nativeTheme.shouldUseDarkColors });
}
nativeTheme.on('updated', pushSystemTheme);

/* 额度临界预警：某真实数据源剩余跌破阈值时推一次系统通知。
   去重键 = 源 + 额度窗 + 当天 + 阈值档，避免每 5 分钟轮询反复轰炸；演示数据不提醒。 */
function checkQuotaAlerts(snap) {
  if (SHOT_MODE || settings.quotaAlert === false || !snap || !snap.snapshot) return;
  const pct = Math.min(50, Math.max(1, Number(settings.quotaAlertPct) || 10));
  const today = new Date().toISOString().slice(0, 10);
  if (!quotaAlertLog) {
    quotaAlertLog = (settings.quotaAlertLog && typeof settings.quotaAlertLog === 'object') ? settings.quotaAlertLog : {};
    /* 只留当天记录，文件不随时间膨胀 */
    for (const k of Object.keys(quotaAlertLog)) if (quotaAlertLog[k] !== today) delete quotaAlertLog[k];
  }
  let changed = false;
  for (const p of (snap.snapshot.providers || [])) {
    if (!p || p.source === 'demo' || p.status === 'error' || p.status === 'expired') continue;
    for (const w of (p.windows || [])) {
      if (w.leftPct == null || w.leftPct > pct) continue;
      const key = [p.id || p.name, w.label, today, pct].join('|');
      if (quotaAlertLog[key]) continue;
      quotaAlertLog[key] = today; changed = true;
      pushNotify('额度告急 · ' + (p.name || '数据源'),
        (w.label || '额度') + ' 仅剩 ' + w.leftPct + '%' + (w.resetAt ? '，' + new Date(w.resetAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 重置' : ''));
    }
  }
  if (changed) { try { store.setInternal({ quotaAlertLog }); } catch (e) { } }
}

/* 当月逐日用量 CSV：Excel 直接双击不乱码（BOM + CRLF + 中文表头） */
function buildUsageCsv(snap) {
  const u = snap && snap.snapshot && snap.snapshot.usage;
  if (!u) return null;
  const perDay = u.perDay || {}, info = u.perDayInfo || {};
  const now = new Date(), y = now.getFullYear(), mo = now.getMonth();
  const dim = new Date(y, mo + 1, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  const rate = u.month > 0 ? (parseFloat(String(u.costMonth || '').replace(/[,¥\s]/g, '')) || 0) / u.month : 0;
  const rows = [['日期', 'Tokens', '估算成本(元)', '会话数', '工具数'].join(',')];
  for (let d = 1; d <= dim; d++) {
    const k = y + '-' + pad(mo + 1) + '-' + pad(d);
    const v = perDay[k] || 0;
    const i = info[k] || {};
    rows.push([k, v, rate > 0 ? (v * rate).toFixed(2) : '', i.sessions || 0, i.tools || 0].join(','));
  }
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

function sendUpdateState(s) {
  if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; } // 有任何状态推进 = 请求活着
  updateState = s;
  if (s && s.type === 'available' && s.version && notifiedUpdate.available !== s.version) {
    notifiedUpdate.available = s.version;
    pushNotify('额度窗有新版本 v' + s.version, '当前 v' + (s.current || app.getVersion()) + '，点击打开并更新');
  } else if (s && s.type === 'downloaded' && s.version && notifiedUpdate.downloaded !== s.version) {
    notifiedUpdate.downloaded = s.version;
    pushNotify('新版本 v' + s.version + ' 已就绪', '点击打开，重启后完成安装');
  }
  if (win && !win.isDestroyed()) win.webContents.send('update:state', s);
}

function setupAutoUpdate() {
  try {
    const { autoUpdater: au } = require('electron-updater');
    autoUpdater = au;
    // electron-updater 6.x 未打包时 checkForUpdates 静默 resolve(null)：自检态强制启用
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;         // 下载需用户点「立即更新」
    autoUpdater.autoInstallOnAppQuit = false; // 安装需用户确认重启
    autoUpdater.on('checking-for-update', () => otaLog('checking'));
    autoUpdater.on('update-available', (info) => {
      // 同版本热修重推防回环（消费标记法）：上次「立即重启」安装的 sha512 与本次 offer 相同 = 已装即已拥有
      const sha = String((info && info.files && info.files[0] && info.files[0].sha512) || '');
      if (sha && sha === String(settings.updSha512 || '')) {
        otaLog('skip consumed repush offer', sha.slice(0, 12));
        sendUpdateState({ type: 'up-to-date', current: app.getVersion() });
        return;
      }
      otaLog('available', info.version);
      sendUpdateState({ type: 'available', version: info.version, current: app.getVersion() });
    });
    autoUpdater.on('update-not-available', () => {
      otaLog('not-available');
      sendUpdateState({ type: 'up-to-date', current: app.getVersion() });
    });
    autoUpdater.on('download-progress', (p) => sendUpdateState({ type: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      pendingUpdateSha = String((info && info.files && info.files[0] && info.files[0].sha512) || '');
      otaLog('downloaded', info.version);
      sendUpdateState({ type: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err) => {
      const msg = String((err && err.message) || err);
      otaLog('error', msg);
      sendUpdateState({ type: 'error', message: msg });
    });
    otaLog('autoUpdater ready');
  } catch (e) { otaLog('autoUpdater init failed', String(e)); }
}

function checkForUpdates(manual) {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  const testing = !!cli || process.argv.includes('--shot-update'); // 自检模式：开发态也真跑更新链路
  const url = effectiveUpdateUrl();
  if (!autoUpdater) { if (manual) sendUpdateState({ type: 'error', message: '更新组件未就绪' }); return; }
  if (!app.isPackaged && !testing) { if (manual) sendUpdateState({ type: 'error', message: '开发模式不支持在线更新' }); return; }
  if (!url) {
    otaLog('skip check: update url not configured');
    if (manual) sendUpdateState({ type: 'unconfigured' });
    return;
  }
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
    otaLog('checking', url);
    // 看门狗：请求可能被坏代理/网络挂死（不回调、不报错），25 秒无状态推进按超时收场
    if (checkWatchdog) clearTimeout(checkWatchdog);
    checkWatchdog = setTimeout(() => {
      checkWatchdog = null;
      otaLog('check timeout');
      sendUpdateState({ type: 'error', message: '检查超时，请检查网络后重试' });
    }, 25000);
    const p = autoUpdater.checkForUpdates();
    if (p && p.catch) p.catch(err => {
      const msg = String((err && err.message) || err);
      otaLog('check error', msg);
      if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; }
      if (manual) sendUpdateState({ type: 'error', message: msg });
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    otaLog('check threw', msg);
    if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; }
    if (manual) sendUpdateState({ type: 'error', message: msg });
  }
}

function startUpdateDownload() {
  if (!autoUpdater) return;
  otaLog('download start');
  sendUpdateState({ type: 'downloading', percent: 0 });
  const p = autoUpdater.downloadUpdate();
  if (p && p.catch) p.catch(err => { const msg = String((err && err.message) || err); otaLog('download error', msg); sendUpdateState({ type: 'error', message: msg }); });
}

function installUpdate() {
  if (!autoUpdater) return;
  otaLog('quitAndInstall');
  // 消费标记落盘：本次安装的安装包 sha512 → 重启后同 offer 按「已装」跳过（防循环弹窗）。
  // 必须在「确认安装」这一刻记录而不是下载完成时——下载后点「稍后」并未拥有，offer 应继续弹。
  if (pendingUpdateSha) { try { store.setInternal({ updSha512: pendingUpdateSha }); } catch (e) { } }
  try { autoUpdater.quitAndInstall(false, true); } catch (e) { otaLog('install error', String(e)); }
}

function scheduleUpdateChecks() {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  setTimeout(() => checkForUpdates(false), cli ? 3000 : 30000); // 启动后首检（测试模式 3 秒）
  updateTimer = setInterval(() => checkForUpdates(false), 4 * 3600 * 1000); // 每 4 小时
}

/* ---------------- OTA 更新链路自检（--shot-update，配合 design/fake-ota-server.js） ----------------
   不带 --update-url= 时走「内置默认源」模式：点「检查更新」应得到真实结果而非「未配置」。 */
if (process.argv.includes('--shot-update')) {
  app.whenReady().then(() => {
    setTimeout(async () => {
      const js = (code) => win.webContents.executeJavaScript(code).catch(() => null);
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      await js(`document.querySelector('#bottombar button[data-v="vSettings"]').click()`);
      await sleep(300);
      await js(`document.getElementById('btnCheckUpdate').click()`);

      if (!process.argv.find(a => a.startsWith('--update-url='))) {
        let st = '';
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          st = await js(`document.getElementById('updateStatus').textContent`);
          if (st && st !== '正在检查…') break;
        }
        const ok = !!st && !/未配置|更新组件未就绪/.test(String(st));
        console.log('[ota-shot] default source status:', JSON.stringify(st), ok ? 'PASS' : 'FAIL');
        console.log('[ota-shot] DONE', ok ? 'PASS' : 'FAIL');
        app.exit(0);
        return;
      }

      /* 假源链路：检查 → available（横幅）→ 下载 → downloaded（立即重启） */
      let t0 = Date.now();
      while (updateState.type !== 'available' && updateState.type !== 'error' && Date.now() - t0 < 20000) await sleep(400);
      console.log('[ota-shot] state after check:', JSON.stringify(updateState));
      const b1 = await js(`JSON.stringify({ visible: document.getElementById('updateBanner').classList.contains('show'), text: document.getElementById('ubText').textContent, primary: document.getElementById('ubPrimary').textContent })`);
      let bannerOk = false;
      try { const o = JSON.parse(b1); bannerOk = o.visible && o.text && o.primary === '立即更新'; } catch (e) { }
      console.log('[ota-shot] banner content', b1, bannerOk ? 'PASS' : 'FAIL');

      await js(`document.getElementById('ubPrimary').click()`);   // 立即更新 → 下载
      t0 = Date.now();
      while (updateState.type !== 'downloaded' && updateState.type !== 'error' && Date.now() - t0 < 60000) await sleep(500);
      console.log('[ota-shot] final state:', JSON.stringify(updateState));
      const du = await js(`document.getElementById('btnDoUpdate').hidden ? '' : document.getElementById('btnDoUpdate').textContent`);
      console.log('[ota-shot] settings update button', JSON.stringify(du), du === '立即重启' ? 'PASS' : 'FAIL');
      console.log('[ota-shot] DONE', (updateState.type === 'downloaded' && du === '立即重启') ? 'PASS' : 'FAIL');
      app.exit(0);
    }, 2500);
  });
}

/* ---------------- 启动 ---------------- */
app.whenReady().then(() => {
  store = createStore(app.getPath('userData'));
  settings = store.raw();
  if (!fs.existsSync(app.getPath('userData'))) fs.mkdirSync(app.getPath('userData'), { recursive: true });

  hub = createHub(settings, snap => {
    lastSnap = snap;
    if (win && !win.isDestroyed()) win.webContents.send('data:update', snap);
    checkQuotaAlerts(snap);
  });
  hub.start();

  createWindow();
  registerIpc();
  buildTray();
  setupAutoUpdate();
  scheduleUpdateChecks();

  if (process.argv.includes('--selftest')) {
    try { app.setPath('userData', app.getPath('userData') + '-selftest'); } catch (e) { }
    setTimeout(runSelfTest, 2500);
  }
  if (HOVER_TEST) setTimeout(runHoverTest, 1800);

  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
});
app.on('before-quit', () => setGlue(false));
