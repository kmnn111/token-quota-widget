'use strict';
/* ext-guard.js — 外链白名单。
   渲染层只允许跳转到「数据卡详情」这类明确可信的站点；
   即便渲染进程被注入，也不许把用户带到钓鱼页。域名按后缀精确匹配。 */
const ALLOWED_HOSTS = [
  'github.com',              // AI 热榜仓库详情
  'platform.xiaomimimo.com', // MiMo 控制台
  'mimo.mi.com',             // MiMo 文档
  'docs.anthropic.com',
  'platform.openai.com'
];

function isAllowedExtUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) {
    return false;
  }
}

module.exports = { isAllowedExtUrl, ALLOWED_HOSTS };
