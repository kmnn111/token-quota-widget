'use strict';
/* app.js — 额度窗渲染层：数据绑定 / 视图切换 / 小窗轮转 / 热榜 / 设置 */

const $ = id => document.getElementById(id);
const frame = $('frame');

/* ---------------- 全局状态 ---------------- */
let settings = { demo: true, rotateSeconds: 5, theme: 'light', trendingRange: 'daily' };
let snap = null;          // { snapshot:{providers,usage}, trending }
let range = 'day';
let roster = [];          // 小窗轮播名单
let curIdx = 0, rotTimer = null, hoverPaused = false;

/* ---------------- 工具 ---------------- */
function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function shortCountdown(iso) {
  if (!iso) return '长期';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '即将重置';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + '分后';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '时' + (m % 60) + '分后';
  return Math.floor(h / 24) + '天' + (h % 24) + '时后';
}
function countdown(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '即将重置';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + '分钟后重置';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '小时' + (m % 60) + '分后重置';
  return Math.floor(h / 24) + '天' + (h % 24) + '小时后重置';
}
function barClass(left) {
  if (left == null) return '';
  if (left < 10) return 'danger';
  if (left < 25) return 'warn';
  return 'calm';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- 总量区 ---------------- */
function renderTotals() {
  const u = snap && snap.snapshot && snap.snapshot.usage;
  const label = { day: '今日 Token 用量', month: '本月 Token 用量', total: '累计 Token 用量' }[range];
  $('tLabel').textContent = label;
  if (!u) {
    $('tNum').innerHTML = '—';
    $('tCost').textContent = '本机未发现 Claude Code / Codex / WorkBuddy 日志';
    $('tMeta').textContent = '在设置里配置额度源，或用演示模式浏览';
    return;
  }
  const v = range === 'day' ? u.day : range === 'month' ? u.month : u.total;
  $('tNum').innerHTML = esc(fmtTokens(v)) + '<small> tokens</small>';
  $('tCost').textContent = (range === 'day' ? u.costDay : range === 'month' ? u.costMonth : '') || '';
  const running = (u.sessions || []).filter(s => s.running).length;
  $('tMeta').textContent = (u.tools || []).length + ' 个工具' + (running ? ' · ' + running + ' 个会话运行中' : '');
}

/* ---------------- MiMo 置顶卡 ---------------- */
function findMimo(provs) {
  return provs.find(p => /mimo/i.test(p.name) || p.id === 'demo-mimo') || provs[0];
}
function renderMimo(provs) {
  const p = findMimo(provs);
  if (!p) return;
  const card = $('mimoCard');
  card.classList.toggle('fog', p.status === 'expired' || p.status === 'error');
  $('mimoMeta').textContent = p.status === 'expired' ? '登录态失效 · 请更新 Cookie'
    : p.status === 'unconfigured' ? '未配置'
    : p.status === 'error' ? '请求失败'
    : (p.plan || '') + (p.source === 'demo' ? ' · 演示' : '');
  const w = (p.windows || []).slice(0, 2);
  /* 整段重绘，避免逐元素改宽度时的样式竞争 */
  $('mimoBody').innerHTML = w.map(x => {
    const left = x.leftPct;
    return `<div class="ql"><span>${esc(x.label)}</span>
        <b class="${left != null && left < 25 ? 'hot' : ''}">${left != null ? '剩余 ' + left + '%' : '—'}</b></div>
      <div class="bar ${barClass(left)}"><i style="width:${left != null ? Math.max(0, 100 - left) : 0}%"></i></div>`;
  }).join('') + `<div class="qfoot"><span>${w[0] && w[0].used != null ? fmtTokens(w[0].used) + ' / ' + fmtTokens(w[0].limit) : ''}</span>
      <span>${p.balance ? '按量余额 ' + p.balance.amount + ' ' + esc(p.balance.currency || '') : countdown(w[0] && w[0].resetAt)}</span></div>`;
}

/* ---------------- 厂商列表（首页） ---------------- */
function renderProviders(all) {
  const top = findMimo(all);
  const provs = top && all.length > 1 ? all.filter(p => p !== top) : all;
  const head = document.querySelector('#provList').parentElement.querySelector('.mh span');
  if (head) head.textContent = provs.length !== all.length ? '其他厂商' : '额度';
  $('provMeta').textContent = all.length + ' 家厂商 · ' + all.reduce((a, p) => a + (p.windows || []).length, 0) + ' 个额度窗';
  $('provList').innerHTML = provs.map(p => {
    const win = (p.windows || []).map(w => `
      <div class="ql"><span>${esc(w.label)}</span><b class="${w.leftPct != null && w.leftPct < 25 ? 'hot' : ''}">${w.leftPct != null ? '剩余 ' + w.leftPct + '%' : '—'}</b></div>
      <div class="bar ${barClass(w.leftPct)}"><i style="width:${w.leftPct != null ? 100 - w.leftPct : 0}%"></i></div>`).join('') ||
      `<div class="ql"><span>${p.status === 'expired' ? '登录态失效' : p.status === 'error' ? esc(p.error || '请求失败').slice(0, 30) : '未配置'}</span></div>`;
    return `<div class="prov ${p.status === 'expired' || p.status === 'error' ? 'fog' : ''}">
      <span class="pdot" style="background:${p.color}"></span>
      <span class="pname">${esc(p.name)}</span>
      <span class="pwin">${win}</span>
      <span class="preset">${esc(countdown(p.windows && p.windows[0] && p.windows[0].resetAt))}</span>
    </div>`;
  }).join('');
}

/* ---------------- 工具 / 会话 ---------------- */
function renderTools() {
  const u = snap && snap.snapshot && snap.snapshot.usage;
  const tools = (u && u.tools || []).slice().sort((a, b) => b.tokens - a.tokens);
  $('toolList').innerHTML = tools.length ? tools.map(t => `
    <div class="row"><span class="rk"><b>${esc(t.name)}</b></span><span class="rv"><b>${fmtTokens(t.tokens)}</b></span></div>`).join('')
    : '<div class="row"><span class="rk">暂无数据</span></div>';
  const sess = (u && u.sessions || []).slice(0, 6);
  $('sessMeta').textContent = sess.length ? (sess.filter(s => s.running).length || '') + ' 运行中' : '';
  $('sessList').innerHTML = sess.length ? sess.map(s => `
    <div class="row"><span class="rk">${s.running ? '<span class="dot" style="display:inline-block;margin-right:5px"></span>' : ''}<b>${esc(s.title)}</b></span>
    <span class="rv">${fmtTokens(s.tokens)}</span></div>`).join('')
    : '<div class="row"><span class="rk">暂无会话记录</span></div>';
}

/* ---------------- 热力图 ---------------- */
function renderHeat() {
  const u = snap && snap.snapshot && snap.snapshot.usage;
  const perDay = u && u.perDay || {};
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push(perDay[d] || 0);
  }
  const max = Math.max(1, ...days);
  const cells = days.map((v, i) => {
    const a = v > 0 ? 0.15 + 0.85 * (v / max) : 0.06;
    const fill = v > 0 ? `rgba(95,199,190,${a.toFixed(2)})` : 'rgba(255,255,255,.06)';
    return `<rect x="${(i % 6) * 21}" y="${Math.floor(i / 6) * 17}" width="18" height="14" rx="4" fill="${fill}"><title>${fmtTokens(v)}</title></rect>`;
  }).join('');
  $('heat').innerHTML = `<svg viewBox="0 0 126 82" height="82">${cells}</svg>`;
  const active = days.filter(v => v > 0).length;
  $('heatMeta').textContent = '近 30 天 ' + active + ' 天活跃';
}

/* ---------------- AI 热榜 ---------------- */
function renderTrending() {
  const t = snap && snap.trending;
  if (!t || !t.items) { $('ghList').innerHTML = '<div class="row"><span class="rk">加载中…</span></div>'; return; }
  $('ghList').innerHTML = t.items.slice(0, 6).map((it, i) => `
    <div class="gh-item" data-repo="${esc(it.repo)}">
      <span class="gh-n">${String(i + 1).padStart(2, '0')}</span>
      <span class="gh-main"><b>${esc(it.repo)}</b><i>${esc(it.desc || '')}</i></span>
      <span class="gh-star">${esc(it.stars || '')}</span>
    </div>`).join('');
  $('ghFoot').textContent = (t.demo ? '演示数据（网络不可达）' : t.stale ? '网络失败 · 沿用上次结果' : '数据来自 GitHub Trending / Search')
    + ' · 每 30 分钟刷新 · 点击打开仓库页';
  $('ghList').querySelectorAll('.gh-item').forEach(el => {
    el.addEventListener('click', () => window.quota.openExternal('https://github.com/' + el.dataset.repo));
  });
}

/* ---------------- 额度详情视图 ---------------- */
function renderLimits() {
  const provs = (snap && snap.snapshot && snap.snapshot.providers) || [];
  $('limitsFull').innerHTML = provs.map(p => `
    <div class="card ${p.id === 'demo-mimo' || /mimo/i.test(p.name) ? 'mimo' : ''}">
      <div class="mh"><span style="color:${p.color}">${esc(p.name)}</span>
        <b>${p.status === 'ok' || p.status === 'demo' ? esc(p.plan || '') : p.status === 'expired' ? '登录态失效' : esc((p.error || p.status).slice(0, 26))}</b></div>
      ${(p.windows || []).map(w => `
        <div class="ql"><span>${esc(w.label)}${w.used != null ? ' · ' + fmtTokens(w.used) + ' / ' + fmtTokens(w.limit) : ''}</span>
        <b class="${w.leftPct != null && w.leftPct < 25 ? 'hot' : ''}">${w.leftPct != null ? '剩余 ' + w.leftPct + '%' : '—'}</b></div>
        <div class="bar ${barClass(w.leftPct)}" style="margin-bottom:7px"><i style="width:${w.leftPct != null ? 100 - w.leftPct : 0}%"></i></div>
        <div class="qfoot" style="margin:0 0 6px"><span>${esc(countdown(w.resetAt))}</span><span>${w.resetType === 'session' ? '会话窗' : w.resetType === 'weekly' ? '周窗' : w.resetType === 'period' ? '周期窗' : ''}</span></div>`).join('')}
      ${p.balance ? `<div class="qfoot" style="margin:0"><span>按量余额</span><span>${p.balance.amount} ${esc(p.balance.currency || '')}</span></div>` : ''}
    </div>`).join('') || '<div class="card"><div class="row"><span class="rk">尚未配置额度源 · 首页为演示数据</span></div></div>';
}

/* ---------------- 小窗轮转 ---------------- */
function buildRoster() {
  const provs = (snap && snap.snapshot && snap.snapshot.providers) || [];
  const pinned = findMimo(provs);   // 置顶厂商固定第一帧，其余按紧迫度排
  roster = provs.filter(p => (p.status === 'ok' || p.status === 'demo') && (p.windows || []).length)
    .map(p => {
      /* 该家最紧急的额度窗（剩余最低） */
      const w = p.windows.slice().sort((a, b) => (a.leftPct ?? 100) - (b.leftPct ?? 100))[0];
      return {
        name: p.name, color: p.color, left: w.leftPct,
        tip: `${p.name.replace(/ Token Plan$/, '')} · ${shortCountdown(w.resetAt)}`,
        sub: w.label + '剩余',
        warn: w.leftPct != null && w.leftPct < 20,
        pinned: p === pinned
      };
    })
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || ((a.left ?? 100) - (b.left ?? 100)));
  curIdx = 0;
  renderPager();
  paintPill(0, false);
  restartRotate();
}
function renderPager() {
  const el = $('pPager');
  if (roster.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = roster.map((_, i) => `<i data-i="${i}"></i>`).join('');
  el.querySelectorAll('i').forEach(dot => {
    dot.addEventListener('click', e => {
      e.stopPropagation();
      paintPill(Number(dot.dataset.i), true);
      restartRotate();
    });
  });
}
const RING_C = 106.8;   // 2πr, r=17
function setRing(left, color) {
  const fg = $('pRingFg');
  fg.style.stroke = color;
  fg.style.strokeDashoffset = (RING_C * (1 - (left == null ? 0 : left) / 100)).toFixed(2);
  $('pRingPct').textContent = left == null ? '--' : left;
}
function paintPill(i, animate) {
  if (!roster.length) {
    $('pSub').textContent = '尚未配置额度源 · 演示模式';
    setRing(null, 'var(--ink3)');
    return;
  }
  curIdx = i;
  const d = roster[i];
  $('pSub').textContent = d.tip;
  $('pSub').classList.toggle('warn', !!d.warn);
  setRing(d.left, d.warn ? 'var(--warn)' : d.color);
  $('pPager').querySelectorAll('i').forEach((dot, k) => {
    dot.classList.toggle('on', k === i);
    dot.style.background = k === i ? d.color : '';
    dot.title = roster[k].name;
  });
  if (animate) [$('pSub'), $('pRing')].forEach(el => { el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); });
}
function restartRotate() {
  if (rotTimer) { clearInterval(rotTimer); rotTimer = null; }
  /* 只有 1 家（或 0 家）完全静止：不显示分页点、不启动定时器 */
  if (roster.length < 2 || settings.rotateEnabled === false) return;
  const sec = Math.max(3, Number(settings.rotateSeconds) || 5);
  rotTimer = setInterval(() => { if (!hoverPaused) paintPill((curIdx + 1) % roster.length, true); }, sec * 1000);
}

/* ---------------- 时钟 ---------------- */
function tickClock() {
  const n = new Date();
  const pad = x => String(x).padStart(2, '0');
  $('pTime').innerHTML = pad(n.getHours()) + ':' + pad(n.getMinutes()) + '<sup>' + pad(n.getSeconds()) + '</sup>';
  const wd = ['日', '一', '二', '三', '四', '五', '六'][n.getDay()];
  $('pDate').textContent = `${n.getMonth() + 1}月${n.getDate()}日 周${wd}`;
}
setInterval(tickClock, 1000);
tickClock();

/* ---------------- 渲染总入口 ---------------- */
function renderAll() {
  const provs = (snap && snap.snapshot && snap.snapshot.providers) || [];
  const bad = provs.some(p => p.status === 'expired' || p.status === 'error');
  const warn = provs.some(p => (p.windows || []).some(w => w.leftPct != null && w.leftPct < 20));
  $('stateDot').className = 'dot' + (bad ? ' err' : warn ? ' warn' : '');
  $('stateTxt').textContent = bad ? '部分源失效' : warn ? '有额度临界' : '已连接';
  renderTotals();
  renderMimo(provs);
  renderProviders(provs);
  renderTools();
  renderHeat();
  renderTrending();
  if (document.getElementById('vLimits').classList.contains('on')) renderLimits();
  buildRoster();
}

/* ---------------- 数据 / 设置 IPC ---------------- */
window.quota.onData(s => { snap = s; renderAll(); });
window.quota.onDockState(s => {
  frame.classList.toggle('docked', !!s.docked);
  frame.classList.toggle('expanded', !!s.expanded);
  hoverPaused = !!s.expanded;
});
window.quota.getSettings().then(s => {
  settings = s;
  document.body.classList.toggle('dark', settings.theme === 'dark');
  $('inTheme').value = settings.theme || 'dark';
  $('inRotate').value = settings.rotateSeconds || 5;
  $('inRefresh').value = settings.refreshMinutes || 5;
  const provs = settings.providers || [];
  const mimo = provs.find(p => p.type === 'mimo');
  $('mimoState').textContent = mimo ? (mimo.hasApiKey ? '已配置 · API Key' : mimo.hasCookie ? '已配置 · Cookie' : '未配置') : '未配置';
  const custom = provs.find(p => p.type === 'custom');
  if (custom) {
    $('inCustomName').value = custom.name || '';
    $('inCustomUrl').value = custom.url || '';
    $('inCustomMap').value = custom.map ? Object.entries(custom.map).map(([k, v]) => k + '=' + v).join(', ') : '';
  }
});
$('btnRefreshNow').addEventListener('click', () => window.quota.refresh());

/* ---------------- 交互 ---------------- */
$('segRange').querySelectorAll('button').forEach(b => {
  b.addEventListener('click', () => {
    $('segRange').querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    range = b.dataset.r;
    renderTotals();
  });
});
$('ghSeg').querySelectorAll('button').forEach(b => {
  b.addEventListener('click', () => {
    $('ghSeg').querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    settings.trendingRange = b.dataset.r;
    window.quota.updateSettings({ trendingRange: b.dataset.r }).then(() => window.quota.refresh());
  });
});
document.querySelectorAll('#bottombar button[data-v]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#bottombar button[data-v]').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
    $(b.dataset.v).classList.add('on');
    if (b.dataset.v === 'vLimits') renderLimits();
  });
});
$('btnDock').addEventListener('click', () => window.quota.winAction('dock'));
$('pill').addEventListener('mouseenter', () => { hoverPaused = true; });
$('pill').addEventListener('mouseleave', () => { hoverPaused = false; });
$('pill').addEventListener('dblclick', () => window.quota.winAction('dock'));

/* 设置保存 */
function saveProviders(next) {
  return window.quota.updateSettings({ providers: next, demo: next.some(p => p.type === 'mimo' || p.type === 'custom') ? false : settings.demo }).then(() => window.quota.refresh());
}
$('btnSaveMimo').addEventListener('click', () => {
  const provs = (settings.providers || []).filter(p => p.type !== 'mimo');
  const apiKey = $('inMimoKey').value.trim();
  const cookie = $('inMimoCookie').value.trim();
  if (!apiKey && !cookie) { $('mimoState').textContent = '至少填一项'; return; }
  provs.push({ id: 'mimo-1', type: 'mimo', name: 'MiMo Token Plan', enabled: true, apiKey, cookie });
  saveProviders(provs).then(() => { $('mimoState').textContent = '已保存'; });
});
$('btnDelMimo').addEventListener('click', () => {
  saveProviders((settings.providers || []).filter(p => p.type !== 'mimo')).then(() => {
    $('inMimoKey').value = ''; $('inMimoCookie').value = ''; $('mimoState').textContent = '已移除';
  });
});
$('btnSaveCustom').addEventListener('click', () => {
  const provs = (settings.providers || []).filter(p => p.type !== 'custom');
  const url = $('inCustomUrl').value.trim();
  if (!url) return;
  const map = {};
  ($('inCustomMap').value || '').split(',').forEach(kv => {
    const [k, v] = kv.split('=').map(x => x && x.trim());
    if (k && v) map[k] = v;
  });
  provs.push({
    id: 'custom-1', type: 'custom', name: $('inCustomName').value.trim() || '自定义端点',
    enabled: true, url, token: $('inCustomToken').value.trim(), map
  });
  saveProviders(provs);
});
$('btnDelCustom').addEventListener('click', () => {
  saveProviders((settings.providers || []).filter(p => p.type !== 'custom')).then(() => {
    $('inCustomName').value = ''; $('inCustomUrl').value = ''; $('inCustomToken').value = ''; $('inCustomMap').value = '';
  });
});
$('btnSaveAppearance').addEventListener('click', () => {
  settings.theme = $('inTheme').value;
  settings.rotateSeconds = Number($('inRotate').value) || 5;
  settings.refreshMinutes = Number($('inRefresh').value) || 5;
  document.body.classList.toggle('dark', settings.theme === 'dark');
  window.quota.updateSettings({
    theme: settings.theme, rotateSeconds: settings.rotateSeconds, refreshMinutes: settings.refreshMinutes
  }).then(() => restartRotate());
});

/* shot 模式：内容就绪后放行截图 */
window.__shotDone = function () { return true; };
