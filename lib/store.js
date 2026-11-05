'use strict';
/* lib/store.js — 设置持久化。
   凭据只写在本机 userData 下，不进仓库、不进日志、不参与 IPC 回传。 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 2,
  demo: true,                 // 没配任何账号时用演示数据，保证开箱可见
  refreshMinutes: 5,
  rotateSeconds: 5,
  rotateEnabled: true,
  showClock: true,
  theme: 'light',
  alwaysOnTop: false,         // v2 起默认不置顶：桌面部件语义，浏览器等程序正常盖住小窗
  edgeDock: true,
  docked: false,
  dockX: null,
  winPos: null,
  trendingEnabled: true,
  trendingRange: 'day',
  providers: [
    // { id, type, name, enabled, cookie, apiKey, baseUrl, ... }
  ]
};

/* 渲染层允许改写的键（防任意键注入 / 原型污染） */
const PUBLIC_KEYS = new Set([
  'demo', 'refreshMinutes', 'rotateSeconds', 'rotateEnabled', 'showClock',
  'theme', 'alwaysOnTop', 'edgeDock', 'trendingEnabled', 'trendingRange',
  'providers'
]);

/* providers 深合并：凭据字段是打码值或空时保留原值，绝不让 ••• 覆盖真实 Cookie/Key/Token；
   视图层标记（hasXxx）不落盘。main.js 与回归测试共用这一份实现。 */
function mergeProviders(prevList, nextList) {
  const old = new Map((prevList || []).map(p => [p.id, p]));
  return (nextList || []).map(p => {
    const prev = old.get(p.id);
    const merged = Object.assign({}, p);
    delete merged.hasCookie; delete merged.hasApiKey; delete merged.hasToken;
    if (!prev) return merged;
    for (const secret of ['cookie', 'apiKey', 'token']) {
      if (!merged[secret] || /^•+$/.test(String(merged[secret]))) {
        merged[secret] = prev[secret] || '';
      }
    }
    return merged;
  });
}

function createStore(userDataDir) {
  const file = path.join(userDataDir, 'settings.json');
  let state = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    /* v2 迁移：旧版默认写死置顶，导致小窗一直盖住浏览器等程序 —— 一次性翻回「不置顶」
       （桌面部件语义）。用户之后在托盘/设置里手动开启置顶不受影响。 */
    if ((Number(saved.version) || 1) < 2) {
      saved.version = 2;
      saved.alwaysOnTop = false;
      try { fs.writeFileSync(file, JSON.stringify(saved, null, 2), 'utf8'); } catch (e) { }
    }
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] !== undefined) state[k] = saved[k];
    }
  } catch (e) { /* 首次运行 */ }

  function persist(patch) {
    if (patch && typeof patch === 'object') {
      for (const k of Object.keys(patch)) {
        if (PUBLIC_KEYS.has(k)) state[k] = patch[k];
      }
    }
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) { /* 只读盘不致命 */ }
    return publicView();
  }

  /* 主进程内部读写用（含凭据） */
  function raw() { return state; }
  function setInternal(patch) {
    Object.assign(state, patch || {});
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) { }
    return state;
  }

  /* 回传给渲染层的视图：Cookie / API Key / Token 一律打码，只留「是否已配置」 */
  function publicView() {
    const v = Object.assign({}, state);
    v.providers = (state.providers || []).map(p => Object.assign({}, p, {
      cookie: p.cookie ? '••••••••' : '',
      apiKey: p.apiKey ? '••••••••' : '',
      token: p.token ? '••••••••' : '',
      hasCookie: !!p.cookie,
      hasApiKey: !!p.apiKey,
      hasToken: !!p.token
    }));
    delete v.cookie;
    delete v.apiKey;
    delete v.token;
    return v;
  }

  return { raw, setInternal, persist, publicView, file };
}

module.exports = { createStore, mergeProviders, DEFAULTS, PUBLIC_KEYS };
