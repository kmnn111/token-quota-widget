'use strict';
/* providers/local-logs.js — 本地用量统计适配器
 *
   不需要任何凭据：直接扫本机 AI 编码工具落盘的会话日志（JSONL），
   统计今日 / 本月 / 累计 token 与估算成本。支持：
   - Claude Code   ~/.claude/projects/ 下全部 .jsonl
   - Codex         ~/.codex/sessions/ 下全部 .jsonl
   - WorkBuddy     ~/.workbuddy/projects/ 下全部 .jsonl
   日志里没有配额字段，所以本适配器产出「用量」而不是「额度窗」；
   额度侧只有把它挂到自定义上限（settings.quotaLimitTokens）时才出剩余百分比。
   隐私：只读 usage 数值字段，正文一行都不碰、不上传。 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const TOOLS = [
  { id: 'claude', name: 'Claude Code', color: '#e08b62', roots: [path.join(HOME, '.claude', 'projects')] },
  { id: 'codex', name: 'Codex', color: '#5fc7be', roots: [path.join(HOME, '.codex', 'sessions')] },
  { id: 'workbuddy', name: 'WorkBuddy', color: '#7b9cf0', roots: [path.join(HOME, '.workbuddy', 'projects')] }
];

/* 粗略价目（USD / 百万 token，输入:输出），可在设置里覆盖 */
const DEFAULT_PRICES = { in: 3, out: 15 };

/* 本地日期键（与渲染层热力图同口径）：必须用本地时区，toISOString 的 UTC 日会错位 */
function localYmd(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function walkJsonl(root, cb, budget) {
  let n = 0;
  let stack;
  try { stack = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  while (stack.length && n < budget) {
    const d = stack.pop();
    const p = path.join(d.parentPath || root, d.name); // Node 20+ parentPath；旧版兜底
    if (d.isDirectory()) {
      let sub;
      try { sub = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { continue; }
      for (const s of sub) { s.parentPath = p; stack.push(s); }
    } else if (d.isFile() && d.name.endsWith('.jsonl')) {
      n++;
      cb(p);
    }
  }
}

function scanTool(tool, dayBudget) {
  const perDay = new Map();      // 'YYYY-MM-DD' -> tokens
  const sessions = [];           // 最近会话
  let total = 0, files = 0;
  for (const root of tool.roots) {
    walkJsonl(root, (p) => {
      files++;
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch (e) { }
      let day = null, dayTokens = 0;
      let line;
      try { line = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
      for (const raw of line.split('\n')) {
        if (!raw) continue;
        let j;
        try { j = JSON.parse(raw); } catch (e) { continue; }
        const u = j && (j.usage || (j.message && j.message.usage) || (j.response && j.response.usage));
        if (!u) continue;
        const t = (u.input_tokens || u.inputTokens || 0) + (u.output_tokens || u.outputTokens || 0)
          + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (!t) continue;
        const ts = j.timestamp || j.created_at || j.time || mtime || null;
        const ymd = ts ? localYmd(ts) : null;
        dayTokens += t; total += t;
        if (ymd) perDay.set(ymd, (perDay.get(ymd) || 0) + t);
      }
      if (dayTokens > 0) {
        sessions.push({ tool: tool.name, file: path.basename(p), tokens: dayTokens, mtime });
      }
    }, dayBudget || 4000);
  }
  return { perDay, total, files, sessions };
}

function fmtCost(usd) {
  if (usd >= 1) return '¥' + (usd * 7.2).toFixed(2);
  return '¥' + (usd * 7.2).toFixed(3);
}

module.exports = {
  id: 'local',
  name: '本机用量',
  color: '#8ab6f5',
  async fetch(cfg) {
    const dayBudget = 5000;
    const tools = [];
    const perDayAll = new Map();
    const sessionsAll = [];
    for (const t of TOOLS) {
      const r = scanTool(t, dayBudget);
      if (r.files === 0 && r.total === 0) continue;
      tools.push({ id: t.id, name: t.name, color: t.color, tokens: r.total, files: r.files });
      for (const [d, v] of r.perDay) perDayAll.set(d, (perDayAll.get(d) || 0) + v);
      for (const s of r.sessions) sessionsAll.push(s);
    }
    if (!tools.length) throw Object.assign(new Error('本机未发现 Claude Code / Codex / WorkBuddy 会话日志'), { status: 'unconfigured' });

    const today = localYmd(new Date());
    const month = today.slice(0, 7);
    let day = 0, monthT = 0;
    for (const [d, v] of perDayAll) {
      if (d === today) day += v;
      if (d.startsWith(month)) monthT += v;
    }
    sessionsAll.sort((a, b) => b.mtime - a.mtime);

    /* 估算成本：输入按 1/3 输出按 2/3 的粗口径（够看量级，不当账本） */
    const est = (t) => t / 1e6 * ((DEFAULT_PRICES.in + DEFAULT_PRICES.out * 2) / 3);

    return {
      usage: {
        day, month: monthT, total: [...perDayAll.values()].reduce((a, b) => a + b, 0),
        costDay: fmtCost(est(day)), costMonth: fmtCost(est(monthT)),
        perDay: Object.fromEntries([...perDayAll.entries()].sort().slice(-30)),
        tools,
        sessions: sessionsAll.slice(0, 8).map(s => ({
          title: s.tool + ' · ' + s.file.replace(/\.jsonl$/, ''),
          tokens: s.tokens, at: new Date(s.mtime).toISOString()
        }))
      },
      windows: [],
      status: 'ok'
    };
  },
  isConfigured() { return true; }
};
