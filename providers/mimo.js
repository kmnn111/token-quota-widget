'use strict';
/* providers/mimo.js — 小米 MiMo Token Plan 额度适配器（双通道）
 *
 * 通道 A（推荐，稳定）：Token Plan 专用 API Key（tp- 开头）
 *   GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan
 *   认证头：api-key: <tp-...> 或 Authorization: Bearer <tp-...>
 *   返回 { plan_code, period:{start_at,end_at}, quota:{total/used/remaining_credits} }
 *
 * 通道 B（可选，信息更细）：控制台浏览器 Cookie（含 api-platform_serviceToken + userId）
 *   GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail   → 套餐与 currentPeriodEnd
 *   GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage    → monthUsage.percent(0..1) + items[]
 *   GET https://platform.xiaomimimo.com/api/v1/balance            → 按量余额（订阅号可能为空）
 *
 * 注意：计划 API Key 与推理网关都读不到 tokenPlan/usage，控制台网关只认 Cookie —— 两条通道互补。
 * Cookie 一般 24 小时左右过期：过期时本适配器只把该家卡片「雾化」，不拖垮其他厂商。 */

const { request } = require('../lib/http');

const API_BASE = 'https://token-plan-cn.xiaomimimo.com';
const CONSOLE_BASE = 'https://platform.xiaomimimo.com';

/* items[] 里的命名 → 界面标签（兜底用 name 原文） */
const ITEM_LABELS = {
  month_total_token: '本月套餐',
  month_bonus_token: '补偿积分',
  month_total_credits: '本月套餐',
  month_bonus_credits: '补偿积分'
};

function pct(used, limit) {
  if (!limit || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100)));
}

async function fetchByKey(cfg) {
  const key = String(cfg.apiKey || '').trim();
  const out = { windows: [], plan: '', resetAt: null, status: 'ok', source: 'api-key' };
  const r = await request(`${API_BASE}/v1/platform/token_plan`, {
    headers: { 'api-key': key, 'Authorization': 'Bearer ' + key }
  });
  const q = r && r.quota;
  if (!q) throw new Error('token_plan 响应缺 quota');
  out.plan = (r.plan_code || '').toUpperCase() || 'Token Plan';
  out.resetAt = r.period && r.period.end_at ? String(r.period.end_at).replace(' ', 'T') : null;
  const used = Number(q.used_credits || 0);
  const total = Number(q.total_credits || 0);
  out.windows.push({
    label: '本月套餐',
    used, limit: total,
    leftPct: pct(used, total),
    unit: 'credits',
    resetAt: out.resetAt,
    resetType: 'period'
  });
  return out;
}

async function fetchByCookie(cfg) {
  const cookie = String(cfg.cookie || '').trim().replace(/^Cookie:\s*/i, '');
  const out = { windows: [], plan: '', resetAt: null, balance: null, status: 'ok', source: 'cookie' };
  const headers = { Cookie: cookie, Referer: CONSOLE_BASE + '/' };

  const [detail, usage, balance] = await Promise.all([
    request(`${CONSOLE_BASE}/api/v1/tokenPlan/detail`, { headers }).catch(e => { throw Object.assign(new Error('控制台登录态失效（' + e.message + '）'), { code: 'AUTH' }); }),
    request(`${CONSOLE_BASE}/api/v1/tokenPlan/usage`, { headers }).catch(() => null),
    request(`${CONSOLE_BASE}/api/v1/balance`, { headers }).catch(() => null)
  ]);

  const d = detail && detail.data;
  if (!d) throw Object.assign(new Error('tokenPlan/detail 无数据，Cookie 可能已过期'), { code: 'AUTH' });
  out.plan = d.planName || (d.planCode || '').split(':')[0].toUpperCase() || 'Token Plan';
  out.resetAt = d.currentPeriodEnd ? String(d.currentPeriodEnd).replace(' ', 'T') : null;

  const mu = usage && usage.data && usage.data.monthUsage;
  if (mu && Array.isArray(mu.items) && mu.items.length) {
    for (const it of mu.items) {
      const used = Number(it.used || 0);
      const limit = Number(it.limit || 0);
      out.windows.push({
        label: ITEM_LABELS[it.name] || it.name,
        used, limit,
        leftPct: limit > 0 ? Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100))) : null,
        unit: 'credits',
        resetAt: out.resetAt,
        resetType: 'monthly'
      });
    }
    if (!out.windows.length && typeof mu.percent === 'number') {
      out.windows.push({ label: '本月套餐', used: null, limit: null, leftPct: Math.round((1 - mu.percent) * 100), unit: 'credits', resetAt: out.resetAt, resetType: 'monthly' });
    }
  } else {
    out.windows.push({ label: '本月套餐', used: null, limit: null, leftPct: null, unit: 'credits', resetAt: out.resetAt, resetType: 'monthly', note: '未返回用量明细' });
  }

  if (balance && balance.data && balance.data.balance !== undefined) {
    out.balance = { amount: Number(balance.data.balance) || 0, currency: balance.data.currency || 'USD' };
  }
  return out;
}

module.exports = {
  id: 'mimo',
  name: 'MiMo Token Plan',
  color: '#ff8a4c',
  kind: 'cookie+key',
  /* 优先 API Key（不掉线），缺 Key 再用 Cookie（信息更全） */
  async fetch(cfg) {
    const errs = [];
    if (cfg.apiKey) {
      try { return await fetchByKey(cfg); } catch (e) { errs.push(e.message); }
    }
    if (cfg.cookie) {
      try { return await fetchByCookie(cfg); } catch (e) {
        if (e.code === 'AUTH') { e.status = 'expired'; throw e; }
        errs.push(e.message);
      }
    }
    throw Object.assign(new Error(errs.join('；') || '未配置 MiMo 凭据'), { status: 'unconfigured' });
  },
  isConfigured(cfg) { return !!(cfg.apiKey || cfg.cookie); }
};
