'use strict';
/* lib/store.js — 设置持久化。
   凭据只写在本机 userData 下，不进仓库、不进日志、不参与 IPC 回传。 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 1,
  demo: true,                 // 没配任何账号时用演示数据，保证开箱可见
  refreshMinutes: 5,
  rotateSeconds: 5,
  rotateEnabled: true,
  showClock: true,
  theme: 'light',
  alwaysOnTop: true,
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

function createStore(userDataDir) {
  const file = path.join(userDataDir, 'settings.json');
  let state = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
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

  /* 回传给渲染层的视图：Cookie / API Key 一律打码，只留「是否已配置」 */
  function publicView() {
    const v = Object.assign({}, state);
    v.providers = (state.providers || []).map(p => Object.assign({}, p, {
      cookie: p.cookie ? '••••••••' : '',
      apiKey: p.apiKey ? '••••••••' : '',
      hasCookie: !!p.cookie,
      hasApiKey: !!p.apiKey
    }));
    delete v.cookie;
    delete v.apiKey;
    return v;
  }

  return { raw, setInternal, persist, publicView, file };
}

module.exports = { createStore, DEFAULTS, PUBLIC_KEYS };
