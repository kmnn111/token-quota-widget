'use strict';
/* providers/custom.js — 自定义余额/额度端点（New API / One API / 自建网关兼容）
 *
   只要求一个 GET 返回 JSON：任意数字字段映射成「已用 / 上限 / 重置时间」。
   配置示例（设置面板里选「自定义端点」）：
     { type:'custom', name:'中转站', url:'https://gw.example.com/api/usage',
       authHeader:'Authorization', token:'sk-xxx',
       map:{ used:'data.used', limit:'data.limit', resetAt:'data.reset', label:'额度' } }
   字段路径用点号表示，支持多额度窗：map.windows='data.items' 时按数组展开。 */

const { request } = require('../lib/http');

function dig(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const k of String(dotted).split('.')) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function toResetAt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  return String(v).replace(' ', 'T');
}

module.exports = {
  id: 'custom',
  name: '自定义端点',
  color: '#b39cf5',
  async fetch(cfg) {
    if (!cfg.url) throw Object.assign(new Error('未配置端点地址'), { status: 'unconfigured' });
    const headers = {};
    if (cfg.token) headers[cfg.authHeader || 'Authorization'] = (cfg.authHeader || 'Authorization') === 'Authorization' && !/^bearer /i.test(cfg.token || '') ? 'Bearer ' + cfg.token : cfg.token;
    const data = await request(cfg.url, { headers, timeout: 10000 });

    const windows = [];
    const map = cfg.map || {};
    const arr = map.windows ? dig(data, map.windows) : null;
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const used = Number(dig(it, map.used || 'used') || 0);
        const limit = Number(dig(it, map.limit || 'limit') || 0);
        windows.push({
          label: String(dig(it, map.label || 'label') || '额度'),
          used, limit,
          leftPct: limit > 0 ? Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100))) : null,
          resetAt: toResetAt(dig(it, map.resetAt || 'resetAt')),
          resetType: 'custom'
        });
      }
    } else {
      const used = Number(dig(data, map.used || 'used') || 0);
      const limit = Number(dig(data, map.limit || 'limit') || 0);
      windows.push({
        label: map.name || '额度',
        used, limit,
        leftPct: limit > 0 ? Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100))) : null,
        resetAt: toResetAt(dig(data, map.resetAt || 'resetAt')),
        resetType: 'custom'
      });
    }
    return { windows, plan: cfg.planName || '', status: 'ok', source: 'custom' };
  },
  isConfigured(cfg) { return !!cfg.url; }
};
