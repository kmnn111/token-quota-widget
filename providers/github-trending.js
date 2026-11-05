'use strict';
/* providers/github-trending.js — AI 热榜（大窗底部模块）
 *
   国人开源优先：抓 GitHub Trending 解析「仓库 + 一句话简介 + 星标」，
   再用 GitHub Search API 补充国人 AI 项目（中文简介 / 国内团队仓库排前面）。
   简介统一译成中文一句话（腾讯 TranSmart 批量 → Google gtx → MyMemory 三通道，失败保留原文）。
   都失败就沿用上次结果（绝不弹错误卡）。点击跳转走主进程外链白名单（只放行 github.com），
   仓库页免费可访问。注意：本机网络链路会吃掉 URL 查询串里的百分号 UTF-8 —— 请求参数只用 ASCII。 */

const { request } = require('../lib/http');

const TOPICS = ['ai', 'llm', 'agent', 'ai-agent', 'llm-framework', 'coding-assistant', 'chatbot', 'rag', 'mcp'];
/* 国人项目高频 topic（仍为 ASCII）：aigc / chatgpt 生态大多是国内团队 */
const CN_TOPICS = ['aigc', 'chatgpt', 'chinese', 'llmops'];
/* 国内 AI 团队 / 活跃组织（owner 小写精确匹配） */
const CN_ORGS = new Set([
  'deepseek-ai', 'qwenlm', 'moonshotai', 'zai-org', 'thudm', 'openbmb', 'internlm', 'baai',
  '01-ai', 'modelscope', 'xiaomi', 'bytedance', 'netease-youdao', 'iflytek', 'sensetime',
  'megvii', 'opendatalab', 'datawhale', 'open-mmlab', 'rvc-boss', '2noise', 'langgenius',
  'labring', 'songquanpeng', 'binary-husky', 'chatanywhere', 'yetone', 'wong2'
]);
const cache = { daily: { ts: 0, items: [] }, weekly: { ts: 0, items: [] } };
const TTL = 30 * 60 * 1000;

const DEMO = {
  daily: [
    { repo: '2noise/ChatTTS', desc: '中文语音合成，说话像真人，本地能跑', stars: '+2.1k', tag: '要配环境' },
    { repo: 'RVC-Boss/GPT-SoVITS', desc: '听几句话就能克隆音色的中文语音箱', stars: '+1.5k', tag: '要配环境' },
    { repo: 'songquanpeng/one-api', desc: '一个接口聚合多家大模型的国产网关', stars: '+980', tag: '一条命令' },
    { repo: 'langgenius/dify', desc: '拖拖拽拽搭知识库和 Agent 的开源平台', stars: '+760', tag: '打开就用' }
  ],
  weekly: [
    { repo: 'deepseek-ai/DeepSeek-Coder', desc: '国产代码大模型，懂整个仓库的补全', stars: '+5.2k', tag: '打开就用' },
    { repo: 'Qwen/Qwen', desc: '阿里通义千问开源模型全家桶', stars: '+4.4k', tag: '打开就用' },
    { repo: 'binary-husky/gpt_academic', desc: '中文学术工具箱，论文润色翻译全包', stars: '+3.1k', tag: '一条命令' },
    { repo: 'labring/FastGPT', desc: '喂文档就能搭中文问答的工作流平台', stars: '+2.6k', tag: '要配环境' }
  ]
};

/* 「简单又概括」压缩：去表情头、取第一句、超长在逗号处收尾，不半截词硬切 */
function shortZh(s) {
  let t = String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!t) return '';
  const end = t.search(/[。！？!]|\. /);
  if (end >= 6 && end < t.length - 1) t = t.slice(0, end);
  t = t.replace(/[。．.!！、，\s]+$/, '');
  if (t.length > 34) {
    const cut = Math.max(t.lastIndexOf('，', 34), t.lastIndexOf('、', 34), t.lastIndexOf(', ', 34));
    t = cut >= 10 ? t.slice(0, cut) : t.slice(0, 33) + '…';
  }
  return t;
}

/* 上手摩擦标签（参考日榜风格）：打开就用 / 一条命令 / 要配环境 */
function frTag(text) {
  const s = String(text || '');
  if (/一条命令|一行命令|one[- ]?(liner|command)|single[- ]?(line|command)/i.test(s)) return '一条命令';
  if (/要配环境|配环境|需要配置|安装配置|docker|compose|requirements\.txt|pip install|npm install|deploy/i.test(s)) return '要配环境';
  if (/打开就用|开箱即用|无需配置|免配置|zero[- ]?config|out of the box|no[- ]?setup|works? out of/i.test(s)) return '打开就用';
  return '';
}

/* ---------------- 简介 → 中文一句话（三通道：TranSmart 批量 → gtx → MyMemory） ---------------- */
const transCache = new Map();
function hasCjk(s) { return /[一-鿿]/.test(s); }
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ① 腾讯 TranSmart：免密钥、批量、自动语种识别、国内可达 */
async function transBatch(texts) {
  if (!texts.length) return [];
  const r = await request('https://transmart.qq.com/api/imt', {
    method: 'POST', timeout: 12000,
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
    body: JSON.stringify({
      header: { fn: 'auto_translation', client_key: 'browser-chrome', user_agent: BROWSER_UA, timestamp: Date.now() },
      source: { lang: 'auto', text_list: texts },
      target: { lang: 'zh' }
    })
  });
  const out = (r && r.auto_translation) || [];
  if (!Array.isArray(out) || out.length !== texts.length || (r.header && r.header.ret_code !== 'succ')) {
    throw new Error('TranSmart 响应异常');
  }
  return out.map(x => String(x || '').trim());
}

/* ②③ 单条兜底：gtx → MyMemory，都失败保留英文原文 */
async function translateOne(text) {
  const src = String(text || '').trim();
  if (!src || hasCjk(src)) return src;              // 已是中文不译
  if (transCache.has(src)) return transCache.get(src);
  let out = src;
  try {
    const r = await request('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(src), { timeout: 8000 });
    const arr = typeof r === 'string' ? JSON.parse(r) : r;
    const zh = ((arr && arr[0]) || []).map(seg => (seg && seg[0]) || '').join('').trim();
    if (zh) out = zh;
  } catch (e) {
    try {
      const r2 = await request('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(src) + '&langpair=en%7Czh-CN', { timeout: 8000 });
      const zh2 = r2 && r2.responseData && r2.responseData.translatedText;
      if (zh2 && !/MYMEMORY WARNING|INVALID|QUERY LENGTH/i.test(String(zh2))) out = String(zh2).trim();
    } catch (e2) { /* 三通道都失败 → 保留英文原文 */ }
  }
  if (transCache.size > 300) transCache.clear();
  transCache.set(src, out);
  return out;
}

/* 国人项目优先：中文简介或国内团队仓库排前（判定基于原文，必须在翻译前算好） */
function isCnItem(it) {
  const owner = String(it.repo || '').split('/')[0].toLowerCase();
  return hasCjk(it.desc || '') || CN_ORGS.has(owner);
}
function cnFirst(items) {
  return items.filter(isCnItem).concat(items.filter(x => !isCnItem(x)));
}
/* 中文为主的文本不译（避免把现成中文简介改写坏）；英文头+中文尾的混排简介整段译成中文 */
function cnPrimary(s) {
  return String(s || '').search(/[一-鿿]/) <= 5 && hasCjk(s);
}
async function enrich(items) {
  const list = items.slice(0, 10).map(it => {
    const o = Object.assign({}, it, { desc: String(it.desc || '').trim().slice(0, 160) });
    o.cn = isCnItem(o);   // 国人项目判定基于原文
    o._orig = o.desc;
    return o;
  });
  const todo = list.filter(it => it.desc && !cnPrimary(it.desc));
  if (todo.length) {
    let zh = [];
    try { zh = await transBatch(todo.map(it => it.desc)); } catch (e) { zh = []; }
    for (let i = 0; i < todo.length; i++) {
      const hit = zh[i] && hasCjk(zh[i]) ? zh[i] : '';
      todo[i].desc = hit || await translateOne(todo[i].desc);
    }
  }
  for (const it of list) {
    it.desc = shortZh(it.desc);                                    // 一句话概括（日榜风格）
    it.tag = it.tag || frTag(it._orig + ' ' + it.desc) || '';       // 上手摩擦标签
    delete it._orig;
  }
  return list.sort((a, b) => Number(b.cn) - Number(a.cn));
}

/* ---------------- 通道 1：Trending 页 ---------------- */
function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function fromTrendingPage(since) {
  const text = await request('https://github.com/trending?since=' + since, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'text/html' },
    timeout: 12000
  });
  if (typeof text !== 'string') return [];
  const items = [];
  const seen = new Set();
  /* 按 <article> 切块：块内第一个两段式 href 即仓库，<p class="...col-9..."> 即简介 */
  for (const art of text.split(/<article\b/).slice(1)) {
    if (items.length >= 10) break;
    const rm = art.match(/href="\/([\w.-]+\/[\w.-]+)"/);
    if (!rm) continue;
    const repo = rm[1];
    if (seen.has(repo)) continue;
    if (/^(topics|collections|sponsors)\//.test(repo)) continue;
    seen.add(repo);
    const dm = art.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const sm = art.match(/([\d,]+)\s+stars?\s+(today|this week)/i);
    items.push({
      repo,
      desc: dm ? stripTags(dm[1]) : '',
      stars: sm ? '+' + sm[1] : ''
    });
  }
  return items;
}

/* ---------------- 通道 2：Search API（补充国人项目） ---------------- */
async function fromSearchApi(range) {
  const days = range === 'weekly' ? 7 : 1;
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const minStars = range === 'weekly' ? 80 : 20;
  /* 主题词轮换（含国人高频 topic），中文筛选在本地做 —— URL 查询串只放 ASCII */
  const pool = TOPICS.concat(CN_TOPICS);
  const term = pool[Math.floor(Date.now() / TTL) % pool.length];
  const q = 'topic:' + term + ' created:>' + since + ' stars:>' + minStars;
  const r = await request('https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&sort=stars&order=desc&per_page=20', { timeout: 12000 });
  const items = (r && r.items || []).map(x => ({
    repo: x.full_name,
    desc: String(x.description || '').slice(0, 80),
    stars: '★ ' + x.stargazers_count
  }));
  if (!items.length) throw new Error('Search 无结果');
  return cnFirst(items).slice(0, 8);
}

/* ---------------- 汇总：双通道 → 中文简介 → 国人优先 ---------------- */
async function fetchTrending(range) {
  const key = range === 'weekly' ? 'weekly' : 'daily';
  const c = cache[key];
  if (c.items.length && Date.now() - c.ts < TTL) return { items: c.items, cached: true, at: c.ts };
  let items = [];
  try { items = await fromTrendingPage(key); } catch (e) { /* 走兜底 */ }
  if (items.length < 6) {
    try {
      const more = await fromSearchApi(key);
      const seen = new Set(items.map(x => x.repo));
      for (const it of more) { if (!seen.has(it.repo)) items.push(it); }
    } catch (e) { /* 走演示 */ }
  }
  if (!items.length) {
    if (c.items.length) return { items: c.items, cached: true, stale: true, at: c.ts };
    return { items: DEMO[key], demo: true, at: Date.now() };
  }
  items = await enrich(items);
  c.items = items; c.ts = Date.now();
  return { items, at: c.ts };
}

module.exports = { fetchTrending };
