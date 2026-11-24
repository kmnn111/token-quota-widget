'use strict';
/* design/test-antigravity.js — Antigravity 适配器端到端自检（纯 Node，不依赖 Electron）
   起一个 mock Connect RPC 服务（HTTP），喂一份贴近真实结构的 userStatus，
   验证：发现→RPC→解析 AI Credits 月额度 / 5小时 / 周配额；再测无服务时的优雅降级。 */
const http = require('http');
const path = require('path');
const agy = require('../providers/antigravity');

const PORT = 17831;
const STATUS = {
  userStatus: {
    email: 'test@gmail.com',
    isAuthenticated: true,
    planStatus: {
      availablePromptCredits: 620,
      planName: 'Google AI Pro',
      planInfo: { monthlyPromptCredits: 1000, planName: 'Google AI Pro' }
    },
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          modelOrAlias: { model: 'gemini-3-pro' }, label: 'Gemini 3 Pro',
          quotaInfo: {
            remainingFraction: 0.42,
            resetTime: new Date(Date.now() + 2 * 3600e3).toISOString(),
            weeklyRemainingFraction: 0.7,
            weeklyResetTime: new Date(Date.now() + 3 * 86400e3).toISOString()
          }
        },
        {
          modelOrAlias: { model: 'claude-sonnet-4-5' }, label: 'Claude Sonnet 4.5',
          quotaInfo: { remainingFraction: 0.05, timeUntilResetMs: 45 * 60e3 }
        },
        { modelOrAlias: { model: 'gemini-2.5-flash' }, label: 'Gemini 2.5 Flash', quotaInfo: { remainingFraction: 0.9 } }
      ]
    }
  }
};

const server = http.createServer((req, res) => {
  if (req.url === '/exa.language_server_pb.LanguageServerService/GetUserStatus') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(STATUS));
  } else if (req.url === '/exa.language_server_pb.LanguageServerService/GetUnleashData') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  } else {
    res.writeHead(404); res.end();
  }
});

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`[agy-test] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

server.listen(PORT, '127.0.0.1', async () => {
  try {
    const r = await agy.fetch({ port: PORT, secure: false, csrfToken: 'mock-token' });
    check('RPC 直连 + 解析成功', r && r.windows && r.windows.length > 0, r && r.windows ? r.windows.length + ' windows' : 'none');
    const byLabel = {};
    (r.windows || []).forEach(w => { byLabel[w.label] = w; });

    check('AI Credits 月额度', byLabel['AI Credits · 本月'] && byLabel['AI Credits · 本月'].limit === 1000,
      byLabel['AI Credits · 本月'] ? byLabel['AI Credits · 本月'].leftPct + '% left' : 'missing');
    check('5 小时配额', byLabel['Gemini 3 Pro · 5 小时'] && byLabel['Gemini 3 Pro · 5 小时'].leftPct === 42,
      byLabel['Gemini 3 Pro · 5 小时'] ? byLabel['Gemini 3 Pro · 5 小时'].leftPct + '%' : 'missing');
    check('每周配额', byLabel['Gemini 3 Pro · 本周'] && byLabel['Gemini 3 Pro · 本周'].leftPct === 70,
      byLabel['Gemini 3 Pro · 本周'] ? byLabel['Gemini 3 Pro · 本周'].leftPct + '%' : 'missing');
    check('多模型组', byLabel['Claude Sonnet 4.5 · 5 小时'] && byLabel['Claude Sonnet 4.5 · 5 小时'].leftPct === 5,
      Object.keys(byLabel).join(' / '));
    check('跳过自动补全模型', !Object.keys(byLabel).some(k => /2\.5/.test(k)), 'gemini-2.5 未出现');
    check('重置时间解析', byLabel['Gemini 3 Pro · 5 小时'] && !!byLabel['Gemini 3 Pro · 5 小时'].resetAt,
      byLabel['Gemini 3 Pro · 5 小时'] && byLabel['Gemini 3 Pro · 5 小时'].resetAt);
    check('邮箱透传', r.email === 'test@gmail.com', r.email);
  } catch (e) {
    check('RPC 直连 + 解析成功', false, e.message);
  }

  /* 降级测试：指定一个无服务的端口，应抛 expired 而非崩溃 */
  try {
    await agy.fetch({ port: 17999, secure: false });
    check('IDE 未运行优雅降级', false, '未抛错');
  } catch (e) {
    check('IDE 未运行优雅降级', e.status === 'expired', 'status=' + e.status + ' · ' + e.message);
  }

  server.close();
  console.log('[agy-test] 汇总:', results.every(Boolean) ? 'ALL PASS' : 'HAS FAIL');
  process.exit(results.every(Boolean) ? 0 : 1);
});
