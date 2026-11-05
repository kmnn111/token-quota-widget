'use strict';
/* providers/index.js — 额度数据中枢（Hub）
   注册所有适配器 → 定时轮询 → 归一化成统一快照推给渲染层。
   单个厂商失败只雾化自己（status:'expired'/'error'），绝不拖垮整盘。 */

const mimo = require('./mimo');
const local = require('./local-logs');
const custom = require('./custom');
const { fetchTrending } = require('./github-trending');

const BUILTIN = { mimo, custom };
/* 内置「本机用量」永远参与（有日志就统计，没有就静默跳过） */

/* ---------- 演示数据（未配置任何账号时的开箱视图） ---------- */
function demoSnapshot() {
  return {
    providers: [
      {
        id: 'demo-mimo', name: 'MiMo Token Plan', color: '#ff8a4c', status: 'demo', plan: 'PRO',
        source: 'demo', updatedAt: Date.now(),
        windows: [
          { label: '本月套餐', used: 7940000, limit: 20800000, leftPct: 62, unit: 'credits', resetAt: isoIn(12 * 3600 + 4 * 60), resetType: 'monthly' },
          { label: '补偿积分', used: 0, limit: 2000000, leftPct: 100, unit: 'credits', resetAt: isoIn(12 * 3600 + 4 * 60), resetType: 'monthly' }
        ],
        balance: null
      },
      {
        id: 'demo-claude', name: 'Claude', color: '#e08b62', status: 'demo', plan: 'PRO', source: 'demo', updatedAt: Date.now(),
        windows: [
          { label: '会话', used: null, limit: null, leftPct: 80, unit: 'tokens', resetAt: isoIn(54 * 60), resetType: 'session' },
          { label: '本周', used: null, limit: null, leftPct: 81, unit: 'tokens', resetAt: isoIn(3 * 3600 - 6 * 60), resetType: 'weekly' }
        ], balance: null
      },
      {
        id: 'demo-codex', name: 'Codex', color: '#5fc7be', status: 'demo', plan: 'PLUS ×2', source: 'demo', updatedAt: Date.now(),
        windows: [
          { label: '本周', used: null, limit: null, leftPct: 55, unit: 'tokens', resetAt: isoIn(6 * 864e5 / 1000 + 10 * 60), resetType: 'weekly' },
          { label: '会话', used: null, limit: null, leftPct: 12, unit: 'tokens', resetAt: isoIn(12 * 60), resetType: 'session' }
        ], balance: null
      },
      {
        id: 'demo-custom', name: '中转站', color: '#b39cf5', status: 'demo', plan: '按量', source: 'demo', updatedAt: Date.now(),
        windows: [{ label: '余额', used: 8.6, limit: 100, leftPct: 91, unit: 'cny', resetAt: null, resetType: 'none' }],
        balance: { amount: 91.4, currency: 'CNY' }
      }
    ],
    usage: demoUsage(),
    at: Date.now()
  };
}

function isoIn(sec) { return new Date(Date.now() + sec * 1000).toISOString(); }

function demoUsage() {
  const perDay = {};
  let d = new Date();
  for (let i = 0; i < 30; i++) {
    perDay[d.toISOString().slice(0, 10)] = Math.round((Math.sin(i / 5) * 0.5 + 0.7) * 9e6 + i % 7 * 1.5e6);
    d = new Date(d.getTime() - 864e5);
  }
  const day = perDay[Object.keys(perDay)[0]];
  let month = 0; for (const k in perDay) if (k.startsWith(new Date().toISOString().slice(0, 7))) month += perDay[k];
  return {
    day, month, total: month * 4.7,
    costDay: '¥104.20', costMonth: '¥2,931.00',
    perDay,
    tools: [
      { id: 'mimo', name: 'MiMo Code', color: '#ff8a4c', tokens: month * 0.42 },
      { id: 'claude', name: 'Claude Code', color: '#e08b62', tokens: month * 0.31 },
      { id: 'codex', name: 'Codex', color: '#5fc7be', tokens: month * 0.18 },
      { id: 'workbuddy', name: 'WorkBuddy', color: '#7b9cf0', tokens: month * 0.09 }
    ],
    sessions: [
      { title: '归档重跑 · 8 个模型', tokens: 3.1e6, at: new Date().toISOString(), running: true },
      { title: '钉钉群文件核对', tokens: 6.4e5, at: isoIn(-1800) },
      { title: '概念稿评审', tokens: 2.2e6, at: isoIn(-86400) }
    ]
  };
}

/* ---------- 真实快照 ---------- */
async function realSnapshot(settings) {
  const out = { providers: [], usage: null, at: Date.now() };
  const jobs = [];
  for (const cfg of (settings.providers || [])) {
    if (cfg.enabled === false) continue;
    const mod = BUILTIN[cfg.type];
    if (!mod) continue;
    jobs.push((async () => {
      try {
        const r = await mod.fetch(cfg);
        return { id: cfg.id, name: cfg.name || mod.name, color: cfg.color || mod.color, status: 'ok', plan: r.plan || '', windows: r.windows || [], balance: r.balance || null, source: r.source, updatedAt: Date.now(), error: '' };
      } catch (e) {
        return {
          id: cfg.id, name: cfg.name || mod.name, color: cfg.color || mod.color,
          status: e.status === 'expired' ? 'expired' : (e.status === 'unconfigured' ? 'unconfigured' : 'error'),
          plan: '', windows: [], balance: null, source: '', updatedAt: Date.now(), error: e.message
        };
      }
    })());
  }
  out.providers = await Promise.all(jobs);
  try {
    const lu = await local.fetch({});
    out.usage = lu.usage;
  } catch (e) { out.usage = null; }
  return out;
}

/* ---------- 调度 ---------- */
function createHub(settings, onSnapshot) {
  let timer = null;
  let busy = false;
  let last = null;
  let lastTrending = null;

  async function tickTrending() {
    try {
      const r = await fetchTrending(settings.trendingRange === 'weekly' ? 'weekly' : 'daily');
      lastTrending = r;
    } catch (e) { /* 榜单失败静默，沿用旧值 */ }
    broadcast();
  }

  function broadcast() {
    const snap = { snapshot: last || demoSnapshot(), trending: lastTrending, at: Date.now() };
    onSnapshot(snap);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const anyConfigured = (settings.providers || []).some(p => p.enabled !== false && ((p.cookie && p.type === 'mimo') || (p.apiKey && p.type === 'mimo') || (p.url && p.type === 'custom')));
      last = settings.demo === false || anyConfigured ? await realSnapshot(settings) : demoSnapshot();
      if (!anyConfigured && settings.demo !== false) last = demoSnapshot();
    } catch (e) {
      if (!last) last = demoSnapshot();
    } finally { busy = false; }
    broadcast();
  }

  return {
    start() {
      tick(); tickTrending();
      if (timer) clearInterval(timer);
      timer = setInterval(tick, Math.max(1, settings.refreshMinutes || 5) * 60 * 1000);
      setInterval(tickTrending, 30 * 60 * 1000);
    },
    stop() { if (timer) clearInterval(timer); },
    refreshNow: tick,
    refreshTrending: tickTrending
  };
}

module.exports = { createHub, demoSnapshot };
