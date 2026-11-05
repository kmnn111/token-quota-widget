# 更新日志

## 0.1.0 — 2026-11-05

首个可运行版本。

### 形态
- 无边框透明玻璃主窗 420×840，白天暖玻璃为默认，夜间玻璃可切
- 拖到屏幕顶边自动收起为 248×64 吸顶小窗（与云上晴雨天气台、云上会议同规格），240ms clip-path 形变
- 小窗三段式：左侧时间 / 日期 / 蓝色副标，右侧 44px 环形图显示剩余百分比（弧长 + 中心数字）
- Win+D / 显示桌面保活三保险：minimize 拦截回拉、screen-saver 级 topmost、壁纸层 WorkerW 胶水（`npm run selftest` 双模式实测通过）
- 多厂商轮转：≥2 家每 5 秒切换，置顶厂商固定第一帧，单家静止；悬停暂停，分页点可手动切
- 托盘常驻、位置记忆、置顶与吸附开关

### 数据
- MiMo Token Plan 双通道：`tp-` API Key（`token-plan-cn.xiaomimimo.com`）优先，控制台 Cookie（`platform.xiaomimimo.com`）兜底并补明细与按量余额
- 多额度窗归一化（套餐 / 补偿 / 会话 / 周窗 / 周期），统一 `QuotaWindow`
- 本地用量统计：Claude Code / Codex / WorkBuddy 会话日志，出今日 / 本月 / 累计、成本估算、30 天热力图、最近会话
- 自定义端点：点号路径映射，兼容 New API / One API 网关
- 单厂商失败只雾化该卡，不影响其他数据源
- 未配置账号时以演示数据展示，开箱可见

### 界面
- 全中文文案，厂商名 / 模型名 / Token / API 等专名保留原文
- 顶栏 Σ• + 今日 / 本月 / 累计；MiMo 置顶卡；其他厂商列表；工具 / 会话 / 活跃度 / AI 热榜
- 额度详情视图：每家全部额度窗、重置倒计时、按量余额
- AI 热榜：本日 / 本周，GitHub Trending 优先、Search API 兜底，30 分钟缓存，点击走域名白名单开浏览器

### 安全
- 凭据只写本机 `settings.json`，回传渲染层时打码，日志不落敏感字段
- `contextIsolation` + 关闭 `nodeIntegration` + 禁止导航与开窗
- 本地日志只读 usage 数值字段
- 外链白名单（github.com 等），HTTPS-only
