# 更新日志

## 1.0.0 · 初始版 — 2026-11-05

Windows 桌面 AI Token 额度仪表盘首个正式版本。

### 形态
- 无边框透明玻璃主窗 420×840 ⇄ 拖到屏幕顶边收起为 280×64 吸顶小窗，240ms clip-path 形变
- 小窗三段式胶囊：时间 / 日期 / 倒计时 | 厂商 logo | 环形图，读数完整不截断
- 20 家厂商官方 logo 库（simple-icons），无图标厂商自动品牌色文字标兜底
- 默认桌面部件语义：浏览器等程序正常盖住小窗，需要置顶可在设置页 / 托盘开启
- Win+D / 显示桌面保活三保险；托盘常驻、位置记忆、多厂商 5 秒轮转、悬停暂停

### 数据
- MiMo Token Plan 双通道（`tp-` API Key 优先，控制台 Cookie 兜底），套餐标签按真实周期推断（年度 / 季度 / 本月 / 本周）
- 本地用量统计：Claude Code / Codex / WorkBuddy 会话日志 → 今日 / 本月 / 累计、成本估算、30 天活跃度热力图（本地日期键）、最近会话
- 自定义端点（兼容 New API / One API 网关）、未配置时演示数据开箱可见、单厂商失败只雾化该卡

### AI 热榜
- 国人开源项目优先：中文简介或国内 AI 团队（DeepSeek / 通义 / Kimi / 智谱 / 面壁 …）仓库置前
- 每条补中文一句话简介：腾讯 TranSmart 批量 → Google gtx → MyMemory 三通道翻译，失败保留原文
- 日榜风格「简单又概括」一句话（取首句、逗号处收尾、不硬切半截词）+ 上手摩擦标签（打开就用 / 一条命令 / 要配环境）
- 本日 / 本周切换，GitHub Trending 优先、Search API 兜底，30 分钟缓存

### 质量与安全
- 真实输入事件点击回归（`design/test-click.js`）、截图回归、`npm run selftest` 双模式实测
- 拖拽 rAF 合帧跟手不掉帧；设置读取失败不阻塞界面；翻译 / 网络失败静默兜底
- 凭据只存本机 `settings.json` 并打码回传；contextIsolation + 禁导航开窗；外链域名白名单
- 安装包产物名 ASCII `TokenQuotaWidget-Setup-x.y.z.exe`
