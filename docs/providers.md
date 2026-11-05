# 数据源接入

额度窗把所有厂商归一化成同一份 `QuotaWindow`，渲染层不认识任何具体厂商。

```js
{
  label: '本月套餐',      // 额度窗名称
  used: 7940000,         // 已用（credits / tokens）
  limit: 20800000,       // 上限
  leftPct: 62,           // 剩余百分比（0-100，界面只认这个）
  unit: 'credits',
  resetAt: '2026-11-17T23:59:59',  // ISO 时间
  resetType: 'monthly'   // session / weekly / monthly / period / custom / none
}
```

适配器接口（`providers/*.js`）：

```js
module.exports = {
  id: 'mimo',
  name: 'MiMo Token Plan',
  color: '#ff8a4c',
  async fetch(cfg) { return { windows: [], plan: '', balance: null, status: 'ok' }; },
  isConfigured(cfg) { return !!(cfg.apiKey || cfg.cookie); }
};
```

新增厂商只需在 `providers/index.js` 的 `BUILTIN` 里注册，渲染层零改动。

---

## MiMo Token Plan（双通道）

小米有两条互不替代的路：

### 通道 A：Token Plan 专用 API Key（推荐）

```http
GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan
api-key: tp-xxxxxxxx
```

```json
{
  "object": "token_plan",
  "plan_code": "pro",
  "period": { "start_at": "2026-09-21 23:59:59", "end_at": "2027-09-21 23:59:59" },
  "quota": { "total_credits": 10000000, "used_credits": 1500000, "remaining_credits": 8500000 },
  "auto_renew": false
}
```

映射：`quota.used_credits / total_credits` → 一个额度窗，`resetAt = period.end_at`，`plan = plan_code`。

优点：长期有效，不受浏览器登录态影响。Key 在 [MiMo 开放平台](https://mimo.mi.com) 的 Token Plan 页面获取（`tp-` 前缀）。

### 通道 B：控制台 Cookie（明细更全）

```http
GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail
GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
GET https://platform.xiaomimimo.com/api/v1/balance
Cookie: api-platform_serviceToken=…; userId=…
```

- `detail` → `data.planCode / planName / currentPeriodEnd / expired`
- `usage` → `data.monthUsage.percent`（**已用比例 0–1**）与 `data.monthUsage.items[]`（套餐积分、补偿积分各一条，`used / limit / percent`）
- `balance` → `data.balance / currency`（按量账户才有）

映射：每个 `items[]` 一条额度窗；`resetAt = currentPeriodEnd`。

**关键约束**

1. 计划 API Key 与推理网关（`token-plan-ams.xiaomimimo.com`）都读不到 `tokenPlan/usage`，控制台网关只认 Cookie。
2. Cookie 约 24 小时失效，失效返回 401 / 登录跳转。适配器会抛 `status: 'expired'`，界面只雾化 MiMo 卡。
3. 取 Cookie：浏览器登录 `platform.xiaomimimo.com` → F12 → Network → 任一 `/api/v1` 请求 → 复制完整 `Cookie` 请求头（须含 `api-platform_serviceToken` 与 `userId`）。

两条通道同时配置时：**API Key 优先**（稳定），失败后自动回落到 Cookie。

---

## 自定义端点

兼容 New API / One API 及任意返回 JSON 的余额接口。

```json
{
  "type": "custom",
  "name": "中转站",
  "url": "https://gw.example.com/api/usage",
  "authHeader": "Authorization",
  "token": "sk-xxx",
  "map": { "used": "data.used", "limit": "data.limit", "resetAt": "data.reset", "label": "额度" }
}
```

- 字段路径用点号；`map.windows = "data.items"` 时按数组展开成多条额度窗
- `resetAt` 支持 ISO 字符串、`YYYY-MM-DD HH:mm:ss`、秒级/毫秒级时间戳
- 只有 `limit > 0` 才算得出剩余百分比，否则只显示原值

---

## 本地用量（免凭据）

| 工具 | 路径 |
|------|------|
| Claude Code | `~/.claude/projects/` 下全部 `.jsonl` |
| Codex | `~/.codex/sessions/` 下全部 `.jsonl` |
| WorkBuddy | `~/.workbuddy/projects/` 下全部 `.jsonl` |

只读取每行的 `usage`（`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`），按 `timestamp` 落到日期桶，产出今日 / 本月 / 累计与 30 天热力图。

- 单次扫描上限 5000 个文件，避免大目录拖慢启动
- 成本是粗口径估算（输入:输出 ≈ 1:2），只用于看量级，不当账本
- 正文、代码、提示词一行都不读、不上传
