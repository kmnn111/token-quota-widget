'use strict';
/* providers/antigravity.js — Google Antigravity 本地额度适配器（只读本机，不联网、不需登录）
 *
 * Antigravity（IDE / App）启动后会在本机起一个语言服务器，通过 Connect RPC 暴露额度状态。
 * 本适配器复刻开源 antigravity-usage 的本地链路，只取「本机数据」：
 *   1) 发现端口与 csrfToken：优先读 ~/.gemini/antigravity/daemon/hub_*.json（含 httpPort/httpsPort/csrfToken），
 *      读不到再从进程命令行提取 --csrf_token / --extension_server_port，并对候选端口做 RPC 探测。
 *   2) POST /exa.language_server_pb.LanguageServerService/GetUserStatus（自签证书需 rejectUnauthorized:false）
 *   3) 解析 userStatus：
 *        planStatus.availablePromptCredits / planInfo.monthlyPromptCredits → AI Credits 月额度
 *        cascadeModelConfigData.clientModelConfigs[] → 每个模型组的 remainingFraction(0..1) + resetTime
 *          弹性识别 5 小时 / 每周两个配额（字段随版本变化，能取到几个显示几个）
 *
 * 失败一律只雾化自己这张卡：IDE 未运行 / 服务未就绪 → 'expired'（界面显示「IDE 未运行」），
 * 不抛给 Hub 影响其他数据源。 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const RPC_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const PROBE_PATH = '/exa.language_server_pb.LanguageServerService/GetUnleashData';
const USER_AGY = path.join(os.homedir(), '.gemini', 'antigravity');

/* ---------- 1. 发现：hub 文件 → 进程命令行 → 端口探测 ---------- */
function readHubFiles() {
  const dir = path.join(USER_AGY, 'daemon');
  try {
    return fs.readdirSync(dir)
      .filter(f => /^hub_.*\.json$/i.test(f))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.mtime || b.httpPort || 0) - (a.mtime || a.httpPort || 0));
  } catch (e) { return []; }
}

function argValue(cmdline, flag) {
  const m = cmdline.match(new RegExp(flag + '[=\\s]+([^\\s]+)'));
  return m ? m[1] : null;
}

/* Windows 用 wmic，失败退回 PowerShell；Unix 用 ps。只提取端口与 token，不落盘。 */
function readProcessInfo() {
  return new Promise(resolve => {
    const done = v => resolve(v || null);
    if (process.platform === 'win32') {
      execFile('wmic', ['process', 'where', "name like '%antigravity%'", 'get', 'processid,commandline', '/format:csv'],
        { maxBuffer: 12 * 1024 * 1024, timeout: 6000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout) return done(null);
          const line = stdout.split('\n').find(l => /csrf_token|extension_server_port/i.test(l));
          if (!line) return done(null);
          const token = argValue(line, '--csrf_token');
          const extPort = argValue(line, '--extension_server_port');
          const pidM = line.trim().match(/,(\d+)\s*$/);
          done({ csrfToken: token, ports: extPort ? [Number(extPort)] : [], pid: pidM ? Number(pidM[1]) : null });
        });
    } else {
      execFile('ps', ['-eo', 'pid,command'], { maxBuffer: 12 * 1024 * 1024, timeout: 6000 }, (err, stdout) => {
        if (err || !stdout) return done(null);
        const line = stdout.split('\n').find(l => /antigravity/i.test(l) && /csrf_token|extension_server_port/i.test(l));
        if (!line) return done(null);
        const token = argValue(line, '--csrf_token');
        const extPort = argValue(line, '--extension_server_port');
        done({ csrfToken: token, ports: extPort ? [Number(extPort)] : [] });
      });
    }
  });
}

/* Connect RPC POST：自签证书放行；非 2xx 视为端口不可用。 */
function rpcPost(port, csrfToken, rpcPath, body, httpsOk) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Connect-Protocol-Version': '1',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (csrfToken) headers['X-Codeium-Csrf-Token'] = csrfToken;
    const doReq = mod => {
      const req = mod.request({
        hostname: '127.0.0.1', port, path: rpcPath, method: 'POST', headers,
        rejectUnauthorized: false, timeout: 3500
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          /* 200 且有 JSON 体 = 可用；401 也说明这个端口是 Connect RPC（仅 token 不对） */
          if ((res.statusCode === 200 || res.statusCode === 401) && text.trim()) {
            let parsed = text;
            try { parsed = JSON.parse(text); } catch (e) { }
            resolve({ ok: true, port, data: parsed });
          } else resolve(null);
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.write(payload);
      req.end();
    };
    if (httpsOk !== false) doReq(https);   // 先 HTTPS（自签证书放行）
    else doReq(http);
  });
}

/* 依次尝试候选端口（https→http），找到能回数据的 Connect 端口即返回。 */
async function probePorts(ports, csrfToken) {
  for (const port of ports) {
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
    const probeBody = { wrapper_data: {} };
    const h = await rpcPost(port, csrfToken, PROBE_PATH, probeBody, true);
    if (h) return { port, secure: true, csrfToken };
    const hh = await rpcPost(port, csrfToken, PROBE_PATH, probeBody, false);
    if (hh) return { port, secure: false, csrfToken };
  }
  return null;
}

async function discover(cfg) {
  /* 手动指定端口优先（界面高级选项，也供自检 mock 使用） */
  const manualPort = Number(cfg && cfg.port);
  if (Number.isFinite(manualPort) && manualPort > 0 && manualPort <= 65535) {
    const token = (cfg && cfg.csrfToken) || null;
    const r = await rpcPost(manualPort, token, RPC_PATH, STATUS_BODY, cfg.secure !== false);
    if (r && r.ok) return { port: manualPort, secure: cfg.secure !== false, csrfToken: token };
    throw Object.assign(new Error('指定端口未响应 · 请确认 IDE 已运行且端口正确'), { status: 'expired' });
  }
  /* 优先 hub 文件：端口与 token 一次拿全，最快最稳 */
  for (const hub of readHubFiles()) {
    const ports = [hub.httpsPort, hub.httpPort].filter(Boolean);
    const token = hub.csrfToken || null;
    for (const port of ports) {
      /* hub 端口直接用 GetUserStatus 探活，省一次探测往返 */
      const r = await rpcPost(port, token, RPC_PATH, STATUS_BODY, true);
      if (r && r.ok) return { port, secure: true, csrfToken: token };
      const rh = await rpcPost(port, token, RPC_PATH, STATUS_BODY, false);
      if (rh && rh.ok) return { port, secure: false, csrfToken: token };
    }
  }
  /* 退路：进程命令行 → 端口探测 */
  const proc = await readProcessInfo();
  if (proc && proc.ports.length) {
    const found = await probePorts(proc.ports, proc.csrfToken);
    if (found) return found;
  }
  return null;
}

const STATUS_BODY = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } };

/* ---------- 2. 解析 userStatus → windows ---------- */
function leftPct(remainingFraction) {
  if (typeof remainingFraction !== 'number' || remainingFraction < 0 || remainingFraction > 1) return null;
  return Math.max(0, Math.min(100, Math.round(remainingFraction * 100)));
}

function resetIso(resetTime, timeUntilResetMs) {
  if (typeof resetTime === 'string' && !isNaN(Date.parse(resetTime))) return new Date(resetTime).toISOString();
  if (typeof timeUntilResetMs === 'number' && timeUntilResetMs > 0) return new Date(Date.now() + timeUntilResetMs).toISOString();
  return null;
}

/* 从 userStatus 中提取「用户态」对象（真身在 userStatus 下，兼容 root） */
function userObject(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return (raw.userStatus && typeof raw.userStatus === 'object') ? raw.userStatus : raw;
}

/* 找模型配置数组：不同版本字段名可能是 clientModelConfigs / clientModels / models */
function findModelConfigs(u) {
  const data = u.cascadeModelConfigData || u.modelConfigData || {};
  for (const key of ['clientModelConfigs', 'clientModels', 'models']) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (Array.isArray(u.clientModelConfigs)) return u.clientModelConfigs;
  return [];
}

/* 取一个模型的显示名与 id（兼容 modelOrAlias.model / modelId / label） */
function modelName(m) {
  const id = (m.modelOrAlias && m.modelOrAlias.model) || m.modelId || m.model || '';
  const label = m.label || m.displayName || m.name || '';
  return { id: String(id), label: String(label || id || '模型') };
}

/* 从单个模型提取配额窗口。不同版本把 5 小时 / 每周配额放在不同字段：
   - quotaInfo.remainingFraction / resetTime（最常见，= 5 小时滚动）
   - quotaInfo.weeklyRemainingFraction / weeklyResetTime 或 quotaInfo.weekly.*
   - 顶层 weeklyQuotaInfo / fiveHourQuotaInfo
   能取到几个就返回几个，全部弹性处理。 */
function modelWindows(m) {
  const { id, label } = modelName(m);
  if (/gemini-2\.5|gemini 2\.5/i.test(id + ' ' + label)) return [];  // 自动补全模型与主模型共享额度，跳过
  const out = [];
  const qi = m.quotaInfo || m.quota || {};
  const push = (suffix, frac, rst, until) => {
    const pct = leftPct(frac);
    if (pct == null) return;
    out.push({
      label: label + (suffix ? ' · ' + suffix : ''),
      used: null, limit: null, pctDisplay: pct,
      leftPct: pct, unit: 'percent',
      resetAt: resetIso(rst, until), resetType: suffix.includes('周') ? 'weekly' : 'session'
    });
  };
  /* 主配额（5 小时） */
  push('5 小时', qi.remainingFraction, qi.resetTime, qi.timeUntilResetMs);
  /* 每周配额：常见两种放法 */
  const w = qi.weekly || qi.weeklyQuota || {};
  push('本周', (qi.weeklyRemainingFraction != null ? qi.weeklyRemainingFraction : w.remainingFraction),
    (qi.weeklyResetTime || w.resetTime), (qi.weeklyTimeUntilResetMs || w.timeUntilResetMs));
  if (m.weeklyQuotaInfo) {
    const wq = m.weeklyQuotaInfo;
    push('本周', wq.remainingFraction, wq.resetTime, wq.timeUntilResetMs);
  }
  if (!out.length && m.isExhausted) {
    out.push({ label, used: null, limit: null, pctDisplay: 0, leftPct: 0, unit: 'percent', resetAt: null, resetType: 'session' });
  }
  return out;
}

/* ---------- 适配器主入口 ---------- */
module.exports = {
  id: 'antigravity',
  name: 'Antigravity',
  color: '#7ec8e3',
  async fetch(cfg) {
    const conn = await discover(cfg);
    if (!conn) {
      throw Object.assign(new Error('IDE 未运行或本地服务未就绪'), { status: 'expired' });
    }
    const client = conn.secure ? https : http;
    const status = await new Promise((resolve, reject) => {
      const payload = JSON.stringify(STATUS_BODY);
      const headers = {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Connect-Protocol-Version': '1', 'Content-Length': Buffer.byteLength(payload)
      };
      if (conn.csrfToken) headers['X-Codeium-Csrf-Token'] = conn.csrfToken;
      const req = client.request({
        hostname: '127.0.0.1', port: conn.port, path: RPC_PATH, method: 'POST', headers,
        rejectUnauthorized: false, timeout: 6000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('RPC HTTP ' + res.statusCode));
          try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('RPC 响应解析失败')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('RPC 超时')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    const u = userObject(status);
    const windows = [];

    /* AI Credits 月额度 */
    const ps = u.planStatus || {};
    const available = ps.availablePromptCredits;
    const monthly = (ps.planInfo && ps.planInfo.monthlyPromptCredits);
    if (typeof available === 'number' && typeof monthly === 'number' && monthly > 0) {
      windows.push({
        label: 'AI Credits · 本月',
        used: Math.max(0, monthly - available), limit: monthly,
        leftPct: Math.max(0, Math.min(100, Math.round(available / monthly * 100))),
        unit: 'credits', resetAt: null, resetType: 'monthly'
      });
    }

    /* 模型组配额（5 小时 / 周） */
    for (const m of findModelConfigs(u)) {
      for (const w of modelWindows(m)) windows.push(w);
    }

    if (!windows.length) {
      throw Object.assign(new Error('已连接但未解析到额度数据'), { status: 'expired' });
    }
    return {
      plan: (u.planStatus && (u.planStatus.planName || (u.planStatus.planInfo || {}).planName)) || '',
      windows,
      balance: null,
      source: 'antigravity-local',
      email: typeof u.email === 'string' ? u.email : ''
    };
  },
  isConfigured() { return true; }   /* 本地服务自动发现，无需凭据 */
};
