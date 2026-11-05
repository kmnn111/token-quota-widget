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
/* K/M/B 后缀旁标注中文单位（百万/千/十亿），照顾不熟悉英文缩写的用户 */
function unitZh(n) {
  if (n == null) return '';
  if (n >= 1e9) return '十亿';
  if (n >= 1e6) return '百万';
  if (n >= 1e3) return '千';
  return '';
}
function fmtTokensZh(n) {          // 纯文本：112.4M（百万）
  const s = fmtTokens(n), u = unitZh(n);
  return u ? s + '（' + u + '）' : s;
}
function fmtTokensHtml(n) {        // HTML：数字 + 小号灰字（百万）
  const s = esc(fmtTokens(n)), u = unitZh(n);
  return u ? s + '<i class="uz">（' + u + '）</i>' : s;
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
  $('tNum').innerHTML = fmtTokensHtml(v) + '<small> tokens</small>';
  $('tCost').textContent = (range === 'day' ? u.costDay : range === 'month' ? u.costMonth : '') || '';
  const running = (u.sessions || []).filter(s => s.running).length;
  $('tMeta').textContent = (u.tools || []).length + ' 个工具' + (running ? ' · ' + running + ' 个会话运行中' : '');
}

/* ---------------- 置顶数据源卡（标题/主题按实际数据源动态显示） ---------------- */
function isMimoProv(p) {
  return !!p && (p.id === 'demo-mimo' || p.type === 'mimo' || /^mimo-/.test(p.id || '') || /mimo/i.test(p.name || ''));
}
function findPin(provs) {
  /* 不预设任何厂商：置顶卡直接展示第一个数据源（配置顺序） */
  return provs[0];
}
function renderPin(provs) {
  const p = findPin(provs);
  if (!p) return;
  const card = $('pinCard');
  card.classList.toggle('mimo', isMimoProv(p));   // MiMo 橙色主题只给真实 MiMo 源
  card.classList.toggle('fog', p.status === 'expired' || p.status === 'error');
  $('pinTitle').textContent = '额度 · ' + (p.name || '数据源');
  $('pinMeta').textContent = p.status === 'expired' ? '登录态失效 · 请更新凭据'
    : p.status === 'unconfigured' ? '未配置'
    : p.status === 'error' ? '请求失败'
    : (p.plan || '') + (p.source === 'demo' ? ' · 演示' : '');
  const w = (p.windows || []).slice(0, 2);
  /* 整段重绘，避免逐元素改宽度时的样式竞争 */
  $('pinBody').innerHTML = w.map(x => {
    const left = x.leftPct;
    return `<div class="ql"><span>${esc(x.label)}</span>
        <b class="${left != null && left < 25 ? 'hot' : ''}">${left != null ? '剩余 ' + left + '%' : '—'}</b></div>
      <div class="bar ${barClass(left)}"><i style="width:${left != null ? Math.max(0, 100 - left) : 0}%"></i></div>`;
  }).join('') + `<div class="qfoot"><span>${w[0] && w[0].used != null ? fmtTokensHtml(w[0].used) + ' / ' + fmtTokensHtml(w[0].limit) : ''}</span>
      <span>${p.balance ? '按量余额 ' + p.balance.amount + ' ' + esc(p.balance.currency || '') : countdown(w[0] && w[0].resetAt)}</span></div>`;
}

/* ---------------- 厂商列表（首页） ---------------- */
function renderProviders(all) {
  const top = findPin(all);
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
    <div class="row"><span class="rk"><b>${esc(t.name)}</b></span><span class="rv"><b>${fmtTokensHtml(t.tokens)}</b></span></div>`).join('')
    : '<div class="row"><span class="rk">暂无数据</span></div>';
  const sess = (u && u.sessions || []).slice(0, 6);
  $('sessMeta').textContent = sess.length ? (sess.filter(s => s.running).length || '') + ' 运行中' : '';
  $('sessList').innerHTML = sess.length ? sess.map(s => `
    <div class="row"><span class="rk">${s.running ? '<span class="dot" style="display:inline-block;margin-right:5px"></span>' : ''}<b>${esc(s.title)}</b></span>
    <span class="rv">${fmtTokensHtml(s.tokens)}</span></div>`).join('')
    : '<div class="row"><span class="rk">暂无会话记录</span></div>';
}

/* ---------------- 热力图 ---------------- */
function localYmd(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d)) return null;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function renderHeat() {
  const u = snap && snap.snapshot && snap.snapshot.usage;
  const perDay = u && u.perDay || {};
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = localYmd(new Date(Date.now() - i * 864e5));
    days.push(perDay[d] || 0);
  }
  const max = Math.max(1, ...days);
  const active = days.filter(v => v > 0).length;
  if (!active) {
    $('heat').innerHTML = '<div style="font-size:10px;color:var(--ink3);padding:14px 0 10px;text-align:center">近 30 天暂无活跃记录 · 使用 AI 编码工具后这里会亮起来</div>';
    $('heatMeta').textContent = '暂无记录';
    return;
  }
  const cells = days.map((v, i) => {
    const a = v > 0 ? 0.15 + 0.85 * (v / max) : 0.06;
    const fill = v > 0 ? `rgba(95,199,190,${a.toFixed(2)})` : 'rgba(255,255,255,.06)';
    return `<rect x="${(i % 6) * 21}" y="${Math.floor(i / 6) * 17}" width="18" height="14" rx="4" fill="${fill}"><title>${fmtTokensZh(v)}</title></rect>`;
  }).join('');
  $('heat').innerHTML = `<svg viewBox="0 0 126 82" height="82">${cells}</svg>`;
  $('heatMeta').textContent = '近 30 天 · ' + active + ' 天活跃';
}

/* ---------------- 用量月历（当月每日强度 + 悬停详情） ---------------- */
let calOffset = 0;   // 0 = 当月，-1 = 上月 …
function parseCostYuan(s) {
  const v = parseFloat(String(s || '').replace(/[,¥\s]/g, ''));
  return Number.isFinite(v) ? v : 0;
}
function renderCalendar() {
  const u = snap && snap.snapshot && snap.snapshot.usage;
  const perDay = (u && u.perDay) || {};
  const infoAll = (u && u.perDayInfo) || {};
  const now = new Date();
  const view = new Date(now.getFullYear(), now.getMonth() + calOffset, 1);
  const y = view.getFullYear(), mo = view.getMonth();
  $('calTitle').textContent = y + ' 年 ' + (mo + 1) + ' 月';
  $('calPrev').disabled = calOffset <= -12;
  $('calNext').disabled = calOffset >= 0;

  const dim = new Date(y, mo + 1, 0).getDate();
  const todayYmd = localYmd(now);
  const pad = x => String(x).padStart(2, '0');
  let monthSum = 0; const vals = [];
  for (let d = 1; d <= dim; d++) {
    const v = perDay[y + '-' + pad(mo + 1) + '-' + pad(d)] || 0;
    vals.push(v); monthSum += v;
  }
  const max = Math.max(1, ...vals);
  /* 逐日成本口径与英雄区一致：本月成本 ÷ 本月 tokens 折算到单日 */
  const costRate = u && u.month > 0 ? parseCostYuan(u.costMonth) / u.month : 0;

  const firstWd = new Date(y, mo, 1).getDay();
  const cells = [];
  for (let i = 0; i < firstWd; i++) cells.push(0);
  for (let d = 1; d <= dim; d++) cells.push(d);

  $('calGrid').innerHTML = cells.map(d => {
    if (!d) return '<div class="d"></div>';
    const ymd = y + '-' + pad(mo + 1) + '-' + pad(d);
    const v = perDay[ymd] || 0;
    const future = ymd > todayYmd;               // 零填充 YMD 字符串可直接比大小
    const cls = ['d'];
    if (future) cls.push('future');
    else if (v > 0) cls.push('has');
    else cls.push('zero');
    if (ymd === todayYmd) cls.push('today');
    const fill = !future && v > 0 ? ` style="background:rgba(95,199,190,${(0.15 + 0.85 * (v / max)).toFixed(2)})"` : '';
    return `<div class="${cls.join(' ')}" data-ymd="${ymd}"${fill}>${d}</div>`;
  }).join('');

  /* 悬停浮层：当日 tokens / 估算成本 / 会话工具数 / 较前日 / 占当月 */
  const tip = $('calTip'), card = $('calCard');
  const hideTip = () => { tip.hidden = true; };
  function showTip(cell) {
    const ymd = cell.dataset.ymd;
    if (!ymd || cell.classList.contains('future')) return;
    const v = perDay[ymd] || 0;
    const dt = new Date(ymd + 'T00:00:00');
    const wd = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()];
    const rows = [];
    if (v > 0) {
      rows.push(`<div class="tn">${fmtTokensHtml(v)}<small>tokens</small></div>`);
      if (costRate > 0) rows.push(`<div class="tr">估算成本 ¥${(v * costRate).toFixed(2)}</div>`);
      const info = infoAll[ymd];
      if (info) rows.push(`<div class="tr">${info.sessions || 0} 个会话 · ${info.tools || 0} 个工具</div>`);
      const prev = perDay[localYmd(new Date(dt.getTime() - 864e5))] || 0;
      if (prev > 0) {
        const pct = (v - prev) / prev * 100;
        rows.push(`<div class="td${pct < 0 ? ' down' : ''}">较前日 ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</div>`);
      }
      if (monthSum > 0) rows.push(`<div class="tr">占当月 ${(v / monthSum * 100).toFixed(1)}%</div>`);
    } else {
      rows.push('<div class="tr">当日无用量记录</div>');
    }
    tip.innerHTML = `<div class="tt">${mo + 1} 月 ${Number(ymd.slice(8))} 日 · 周${wd}${ymd === todayYmd ? ' · 今天' : ''}</div>` + rows.join('');
    tip.hidden = false;
    /* 定位：水平对准格子并钳在卡内；下方放不下翻到上方 */
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = cell.offsetLeft + cell.offsetWidth / 2 - tw / 2;
    left = Math.max(4, Math.min(left, card.clientWidth - tw - 4));
    let top = cell.offsetTop + cell.offsetHeight + 8;
    if (top + th > card.clientHeight - 4) top = Math.max(4, cell.offsetTop - th - 8);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  $('calGrid').querySelectorAll('.d[data-ymd]').forEach(cell => {
    if (cell.classList.contains('future')) return;
    cell.addEventListener('mouseenter', () => showTip(cell));
    cell.addEventListener('mouseleave', hideTip);
  });
}
$('calPrev').addEventListener('click', () => { calOffset = Math.max(-12, calOffset - 1); renderCalendar(); });
$('calNext').addEventListener('click', () => { calOffset = Math.min(0, calOffset + 1); renderCalendar(); });

/* ---------------- AI 热榜 ---------------- */
function renderTrending() {
  const t = snap && snap.trending;
  if (!t || !t.items) { $('ghList').innerHTML = '<div class="row"><span class="rk">加载中…</span></div>'; return; }
  $('ghList').innerHTML = t.items.slice(0, 6).map((it, i) => `
    <div class="gh-item" data-repo="${esc(it.repo)}">
      <span class="gh-n">${String(i + 1).padStart(2, '0')}</span>
      <span class="gh-main"><b>${esc(it.repo)}</b><i>${esc(it.desc || '')}</i></span>
      ${it.tag ? `<span class="gh-tag">${esc(it.tag)}</span>` : ''}
      <span class="gh-star">${esc(it.stars || '')}</span>
    </div>`).join('');
  $('ghFoot').textContent = (t.demo ? '演示数据（网络不可达）' : t.stale ? '网络失败 · 沿用上次结果' : 'GitHub Trending · 国人开源优先')
    + ' · 每 30 分钟刷新 · 点击打开仓库页';
  $('ghList').querySelectorAll('.gh-item').forEach(el => {
    el.addEventListener('click', () => window.quota.openExternal('https://github.com/' + el.dataset.repo));
  });
}

/* ---------------- 额度详情视图 ---------------- */
function renderLimits() {
  const provs = (snap && snap.snapshot && snap.snapshot.providers) || [];
  $('limitsFull').innerHTML = provs.map(p => `
    <div class="card ${isMimoProv(p) ? 'mimo' : ''}">
      <div class="mh"><span style="color:${p.color}">${esc(p.name)}</span>
        <b>${p.status === 'ok' || p.status === 'demo' ? esc(p.plan || '') : p.status === 'expired' ? '登录态失效' : esc((p.error || p.status).slice(0, 26))}</b></div>
      ${(p.windows || []).map(w => `
        <div class="ql"><span>${esc(w.label)}${w.used != null ? ' · ' + fmtTokensHtml(w.used) + ' / ' + fmtTokensHtml(w.limit) : ''}</span>
        <b class="${w.leftPct != null && w.leftPct < 25 ? 'hot' : ''}">${w.leftPct != null ? '剩余 ' + w.leftPct + '%' : '—'}</b></div>
        <div class="bar ${barClass(w.leftPct)}" style="margin-bottom:7px"><i style="width:${w.leftPct != null ? 100 - w.leftPct : 0}%"></i></div>
        <div class="qfoot" style="margin:0 0 6px"><span>${esc(countdown(w.resetAt))}</span><span>${w.resetType === 'session' ? '会话窗' : w.resetType === 'weekly' ? '周窗' : w.resetType === 'period' ? '周期窗' : ''}</span></div>`).join('')}
      ${p.balance ? `<div class="qfoot" style="margin:0"><span>按量余额</span><span>${p.balance.amount} ${esc(p.balance.currency || '')}</span></div>` : ''}
    </div>`).join('') || '<div class="card"><div class="row"><span class="rk">尚未配置额度源 · 首页为演示数据</span></div></div>';
}

/* ---------------- 小窗轮转 ---------------- */
function buildRoster() {
  const provs = (snap && snap.snapshot && snap.snapshot.providers) || [];
  const pinned = findPin(provs);   // 置顶厂商固定第一帧，其余按紧迫度排
  roster = provs.filter(p => (p.status === 'ok' || p.status === 'demo') && (p.windows || []).length)
    .map(p => {
      /* 该家最紧急的额度窗（剩余最低） */
      const w = p.windows.slice().sort((a, b) => (a.leftPct ?? 100) - (b.leftPct ?? 100))[0];
      return {
        name: p.name, color: p.color, left: w.leftPct, resetAt: w.resetAt,
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
  const pill = $('pill');
  if (!roster.length) {
    const lg0 = window.logoFor('额度窗', '#7b8aa5');
    pill.style.setProperty('--brand', lg0.brand);
    $('pChip').textContent = '尚未配置额度源 · 演示模式';
    $('pChip').classList.remove('warn');
    $('pCount').textContent = '';
    $('pLogo').innerHTML = lg0.svg;
    setRing(null, 'var(--ink3)');
    return;
  }
  curIdx = i;
  const d = roster[i];
  const lg = window.logoFor(d.name, d.color);
  pill.style.setProperty('--brand', lg.brand);
  $('pChip').textContent = lg.display;
  $('pChip').classList.toggle('warn', !!d.warn);
  $('pCount').textContent = d.resetAt ? ' · ' + shortCountdown(d.resetAt) : '';
  $('pLogo').innerHTML = lg.svg;
  setRing(d.left, d.warn ? 'var(--warn)' : lg.brand);
  $('pPager').querySelectorAll('i').forEach((dot, k) => {
    dot.classList.toggle('on', k === i);
    dot.style.background = k === i ? lg.brand : '';
    dot.title = roster[k].name;
  });
  if (animate) [pill.querySelector('.pmid'), $('pLogo'), $('pRing')].forEach(el => {
    el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
  });
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
  renderPin(provs);
  renderProviders(provs);
  renderTools();
  renderHeat();
  renderCalendar();
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
  $('inTop').checked = !!settings.alwaysOnTop;
  syncTypeForm();
  renderSrcList();
}).catch(() => { /* 设置读取失败不阻塞界面 */ });
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

/* ---------------- 数据源管理：多条目清单 + 添加 / 编辑 / 删除 ---------------- */
function saveProviders(next) {
  /* 有任何真实源就退出演示；全删完回到演示模式（开箱可见） */
  const demo = next.length ? false : true;
  return window.quota.updateSettings({ providers: next, demo }).then(s => {
    /* 同步本地视图（含 hasApiKey/hasCookie 打码态），避免连续增删基于旧列表互相覆盖 */
    if (s && s.providers) settings = s;
    renderSrcList();
    return window.quota.refresh();
  });
}
function srcSummary(p) {
  if (p.type === 'mimo') {
    const bits = [p.hasApiKey ? 'API Key' : '', p.hasCookie ? 'Cookie' : ''].filter(Boolean);
    return bits.length ? bits.join(' + ') : '未配置凭据';
  }
  try { return new URL(p.url).host + (p.map && p.map.windows ? ' · 多额度窗' : ''); } catch (e) { return p.url || '未配置地址'; }
}
function renderSrcList() {
  const provs = settings.providers || [];
  $('srcCount').textContent = provs.length ? '已添加 ' + provs.length + ' 个' : '0 个';
  $('srcEmpty').style.display = provs.length ? 'none' : '';
  $('srcList').innerHTML = provs.map(p => `
    <div class="src-item" data-id="${esc(p.id)}">
      <span class="src-type t-${p.type === 'mimo' ? 'mimo' : 'custom'}">${p.type === 'mimo' ? 'MiMo' : '中转站'}</span>
      <span class="src-main"><b>${esc(p.name || (p.type === 'mimo' ? 'MiMo Token Plan' : '自定义端点'))}</b>
        <i>${esc(srcSummary(p))}</i></span>
      <button class="src-edit" data-act="edit" title="编辑">✎</button>
      <button class="src-del" data-act="del" title="删除">✕</button>
    </div>`).join('');
}
function setEditState(editing) {
  $('btnAddSrc').textContent = editing ? '保存修改' : '添加';
  $('btnCancelEdit').hidden = !editing;
}
function syncTypeForm() {
  const t = $('inSrcType').value;
  $('frmMimo').style.display = t === 'mimo' ? '' : 'none';
  $('frmCustom').style.display = t === 'custom' ? '' : 'none';
}
function clearForm() {
  $('inMimoKey').value = ''; $('inMimoCookie').value = '';
  $('inCustomName').value = ''; $('inCustomUrl').value = ''; $('inCustomToken').value = ''; $('inCustomMap').value = '';
}
let editingId = null;
$('inSrcType').addEventListener('change', () => { editingId = null; setEditState(false); syncTypeForm(); });
$('btnCancelEdit').addEventListener('click', () => {
  editingId = null; setEditState(false); clearForm(); syncTypeForm();
});
$('srcList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.src-item').dataset.id;
  const p = (settings.providers || []).find(x => x.id === id);
  if (!p) return;
  if (btn.dataset.act === 'edit') {
    /* 编辑：回填表单（凭据打码值不可回读，留空 = 保持原值，填了 = 覆盖） */
    editingId = id;
    $('inSrcType').value = p.type;
    syncTypeForm();
    clearForm();
    if (p.type === 'mimo') {
      $('inMimoKey').placeholder = p.hasApiKey ? '已配置 · 留空保持不变' : 'tp-xxxxxxxx';
      $('inMimoCookie').placeholder = p.hasCookie ? '已配置 · 留空保持不变' : 'api-platform_serviceToken=…; userId=…';
    } else {
      $('inCustomName').value = p.name || '';
      $('inCustomUrl').value = p.url || '';
      $('inCustomMap').value = p.map ? Object.entries(p.map).map(([k, v]) => k + '=' + v).join(', ') : '';
      $('inCustomToken').placeholder = p.hasToken ? '已配置 · 留空保持不变' : 'sk-…';
    }
    setEditState(true);
    $('frmMimo').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    /* 删除单条 */
    saveProviders((settings.providers || []).filter(x => x.id !== id)).then(() => {
      if (editingId === id) { editingId = null; setEditState(false); clearForm(); syncTypeForm(); }
    });
  }
});
$('btnAddSrc').addEventListener('click', () => {
  const type = $('inSrcType').value;
  const provs = (settings.providers || []).slice();
  const editing = editingId ? provs.find(x => x.id === editingId) : null;
  const entry = editing || { id: type + '-' + Date.now().toString(36), type, enabled: true };

  if (type === 'mimo') {
    const apiKey = $('inMimoKey').value.trim();
    const cookie = $('inMimoCookie').value.trim();
    /* 编辑时留空 = 保持原值（main.js 对打码/空值做深合并） */
    if (!editing && !apiKey && !cookie) { $('inMimoKey').placeholder = '至少填一项：API Key 或 Cookie'; return; }
    if (!editing) {
      /* 多账号自动编号区分：MiMo Token Plan / MiMo Token Plan 2 … */
      const n = provs.filter(x => x.type === 'mimo').length + 1;
      Object.assign(entry, { type: 'mimo', name: n > 1 ? 'MiMo Token Plan ' + n : 'MiMo Token Plan' });
    }
    if (apiKey) entry.apiKey = apiKey;
    if (cookie) entry.cookie = cookie;
  } else {
    const url = $('inCustomUrl').value.trim();
    if (!url) { $('inCustomUrl').placeholder = '请填写额度 JSON 地址'; return; }
    const map = {};
    ($('inCustomMap').value || '').split(',').forEach(kv => {
      const [k, v] = kv.split('=').map(x => x && x.trim());
      if (k && v) map[k] = v;
    });
    Object.assign(entry, {
      type: 'custom', name: $('inCustomName').value.trim() || '自定义端点',
      url, map
    });
    const token = $('inCustomToken').value.trim();
    if (token) entry.token = token; else delete entry.token;
  }
  if (!editing) provs.push(entry);
  saveProviders(provs).then(() => {
    editingId = null; setEditState(false); clearForm(); syncTypeForm();
    $('srcHint').textContent = editing ? '已保存修改' : '已添加 · 可继续添加下一个';
  });
});
$('btnSaveAppearance').addEventListener('click', () => {
  settings.theme = $('inTheme').value;
  settings.rotateSeconds = Number($('inRotate').value) || 5;
  settings.refreshMinutes = Number($('inRefresh').value) || 5;
  settings.alwaysOnTop = $('inTop').checked;
  document.body.classList.toggle('dark', settings.theme === 'dark');
  window.quota.updateSettings({
    theme: settings.theme, rotateSeconds: settings.rotateSeconds, refreshMinutes: settings.refreshMinutes,
    alwaysOnTop: settings.alwaysOnTop
  }).then(() => restartRotate());
});

/* ---------------- 软件更新（OTA，照搬天气台语义） ---------------- */
let manualCheck = false;
let lastUpdateState = null;
function updStatus(t) { const el = $('updateStatus'); if (el) el.textContent = t; }
function hideBanner() { const b = $('updateBanner'); if (b) b.classList.remove('show'); }
/* 「稍后」按 版本+状态 记忆：同一版本的同一提醒只弹一次（跨启动不复发） */
function dismissedKey(type, ver) { return 'updDismiss_' + type + '_' + ver; }
function dismissBanner() {
  const s = lastUpdateState || {};
  if ((s.type === 'available' || s.type === 'downloaded') && s.version) {
    try { localStorage.setItem(dismissedKey(s.type, s.version), '1'); } catch (e) { }
  }
  hideBanner();
}
function showBanner(html, primaryLabel, showPrimary) {
  const b = $('updateBanner'); if (!b) return;
  $('ubText').innerHTML = html;
  const p = $('ubPrimary');
  p.hidden = !showPrimary;
  if (showPrimary) { p.textContent = primaryLabel; p.disabled = false; }
  b.classList.add('show');
}
function setDoUpdate(label) {
  const b = $('btnDoUpdate'); if (!b) return;
  if (label) { b.hidden = false; b.textContent = label; b.disabled = false; }
  else b.hidden = true;
}
function onUpdateState(s) {
  if (!s || !s.type) return;
  lastUpdateState = s;
  const cur = s.current ? 'v' + esc(s.current) : '';
  switch (s.type) {
    case 'available':
      manualCheck = false;
      updStatus('发现新版本 v' + esc(s.version));
      setDoUpdate('立即更新');
      if (!localStorage.getItem(dismissedKey('available', s.version))) {
        showBanner('发现新版本 <b>v' + esc(s.version) + '</b>（当前 ' + cur + '）', '立即更新', true);
      }
      break;
    case 'downloading':
      $('updateBanner').classList.add('show');
      $('ubText').innerHTML = '正在下载更新… <b>' + (s.percent || 0) + '%</b>';
      $('ubPrimary').hidden = true;
      updStatus('正在下载 ' + (s.percent || 0) + '%');
      setDoUpdate(null);
      break;
    case 'downloaded':
      updStatus('更新已就绪，重启后安装');
      setDoUpdate('立即重启');
      if (!localStorage.getItem(dismissedKey('downloaded', s.version))) {
        showBanner('新版本 <b>v' + esc(s.version) + '</b> 已就绪，重启后完成安装', '立即重启', true);
      }
      break;
    case 'up-to-date':
      if (manualCheck) updStatus('已是最新版本（' + cur + '）');
      manualCheck = false;
      setDoUpdate(null);
      break;
    case 'unconfigured':
      if (manualCheck) updStatus('未配置更新服务器地址');
      manualCheck = false;
      setDoUpdate(null);
      break;
    case 'error':
      if (manualCheck) updStatus('检查失败：' + esc(String(s.message || '未知错误').replace(/\s+/g, ' ').slice(0, 60)));
      manualCheck = false;
      setDoUpdate(null);
      break;
  }
}
window.quota.onUpdateState(onUpdateState);
window.quota.getUpdateState().then(s => { if (s && s.type && s.type !== 'idle') onUpdateState(s); }).catch(() => { });
$('btnCheckUpdate').addEventListener('click', () => {
  manualCheck = true;
  updStatus('正在检查…');
  window.quota.updateCheck();
});
function startPendingUpdate() {
  if ((lastUpdateState || {}).type === 'downloaded') window.quota.updateInstall();
  else window.quota.updateDownload();
}
$('btnDoUpdate').addEventListener('click', startPendingUpdate);
$('ubPrimary').addEventListener('click', startPendingUpdate);
$('ubLater').addEventListener('click', dismissBanner);
$('btnSaveUpdateUrl').addEventListener('click', () => {
  const url = $('updateUrlInput').value.trim();
  window.quota.updateSettings({ updateUrl: url }).then(() => {
    updStatus(url ? '已保存自定义更新源' : '已恢复官方更新源');
  });
});
$('updVer').textContent = '当前 v' + (window.quota.version || '');
$('sigVer').textContent = '额度窗 v' + (window.quota.version || '') + ' · 本地优先 · 凭据只存本机';

/* ---------------- 手动窗口拖拽（透明窗 app-region 会吞点击，改为手动） ---------------- */
let dragPrev = null, dragPending = null, dragRaf = 0;
function dragMove(e) {
  if (!dragPrev) return;
  dragPending = { x: e.screenX, y: e.screenY };
  if (dragRaf) return;
  /* rAF 合帧：每帧至多一次 IPC，拖拽跟手且不掉帧 */
  dragRaf = requestAnimationFrame(() => {
    dragRaf = 0;
    if (!dragPrev || !dragPending) return;
    window.quota.winDrag(dragPrev.x, dragPrev.y);
    dragPrev = dragPending; dragPending = null;
  });
}
function dragUp() {
  if (!dragPrev) return;
  if (dragPending) { window.quota.winDrag(dragPrev.x, dragPrev.y); dragPrev = dragPending; dragPending = null; }
  dragPrev = null;
  if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
  window.removeEventListener('mousemove', dragMove);
  window.removeEventListener('mouseup', dragUp);
  window.quota.winDragEnd();
}
function bindWinDrag(el) {
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.seg, .state, .pager, button, input, select, textarea, a')) return;
    dragPrev = { x: e.screenX, y: e.screenY };
    window.quota.winDragStart();
    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragUp);
    e.preventDefault();
  });
}
bindWinDrag(document.querySelector('.topbar'));
bindWinDrag($('pill'));

/* shot 模式：内容就绪后放行截图 */
window.__shotDone = function () { return true; };
