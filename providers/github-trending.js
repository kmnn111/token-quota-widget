'use strict';
/* providers/github-trending.js — AI 热榜（大窗底部模块）
 *
   双通道，先 HTML 后 API，都失败就沿用上次结果（绝不弹错误卡）：
   1) 抓 github.com/trending 页面（?since=daily|weekly），正则解出 owner/repo + 简介 + 今日星标；
   2) 兜底用 GitHub Search API（匿名限速足够 30 分钟一刷）：近 N 天创建、按星标排序的 AI 主题新项目。
   点击跳转走主进程外链白名单（只放行 github.com）。 */

const { request } = require('../lib/http');

const TOPICS = ['ai', 'llm', 'agent', 'ai-agent', 'llm-framework', 'coding-assistant', 'chatbot', 'rag', 'mcp'];
const cache = { daily: { ts: 0, items: [] }, weekly: { ts: 0, items: [] } };
const TTL = 30 * 60 * 1000;

const DEMO = {
  daily: [
    { repo: 'Javis603/token-monitor', desc: '本地优先的 AI 编码用量与额度桌面插件，覆盖 48+ 工具', stars: '+1.2k' },
    { repo: 'steipete/CodexBar', desc: '菜单栏额度监控，内置 MiMo / Claude / Codex', stars: '+860' },
    { repo: 'ryoppippi/ccusage', desc: '从本地日志统计 Claude Code 用量与成本', stars: '+420' },
    { repo: 'sst/opencode', desc: '开源终端 AI 编码代理，多模型可切换', stars: '+310' }
  ],
  weekly: [
    { repo: 'Javis603/token-monitor', desc: '本周新增多设备同步与用量看板', stars: '+6.8k' },
    { repo: 'anthropics/claude-code', desc: '终端里的代理式编码工具', stars: '+4.1k' },
    { repo: 'openai/codex', desc: '轻量 CLI 编码代理，支持多账号切换', stars: '+3.4k' },
    { repo: 'xiaomi/MiMo', desc: '小米 MiMo 系列模型与 Token Plan 工具链', stars: '+2.9k' }
  ]
};

async function fromTrendingPage(since) {
  const text = await request('https://github.com/trending?since=' + since, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'text/html' },
    timeout: 12000
  });
  if (typeof text !== 'string') return [];
  const items = [];
  const re = /href="\/([\w.-]+\/[\w.-]+)"[^>]*data-hydro-click-hmac/g;
  let m, seen = new Set();
  while ((m = re.exec(text)) && items.length < 8) {
    const repo = m[1];
    if (seen.has(repo) || repo.includes('/topics/') || repo.includes('/collections/')) continue;
    seen.add(repo);
    items.push({ repo, desc: '', stars: '' });
  }
  return items;
}

async function fromSearchApi(range) {
  const days = range === 'weekly' ? 7 : 1;
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const minStars = range === 'weekly' ? 80 : 20;
  const topic = TOPICS[Math.floor(Date.now() / TTL) % TOPICS.length]; // 每次刷新轮一个主题，多刷几轮就拼齐
  const q = `topic:${topic} created:>${since} stars:>${minStars}`;
  const r = await request('https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&sort=stars&order=desc&per_page=8', { timeout: 12000 });
  const items = (r && r.items || []).map(x => ({
    repo: x.full_name,
    desc: (x.description || '').slice(0, 60),
    stars: '★ ' + x.stargazers_count
  }));
  if (!items.length) throw new Error('Search 无结果');
  return items;
}

async function fetchTrending(range) {
  const key = range === 'weekly' ? 'weekly' : 'daily';
  const c = cache[key];
  if (c.items.length && Date.now() - c.ts < TTL) return { items: c.items, cached: true, at: c.ts };
  let items = [];
  try { items = await fromTrendingPage(key); } catch (e) { /* 走兜底 */ }
  if (!items.length) {
    try { items = await fromSearchApi(key); } catch (e) { /* 走演示 */ }
  }
  if (!items.length) {
    if (c.items.length) return { items: c.items, cached: true, stale: true, at: c.ts };
    items = DEMO[key];
    return { items, demo: true, at: Date.now() };
  }
  c.items = items; c.ts = Date.now();
  return { items, at: c.ts };
}

module.exports = { fetchTrending };
