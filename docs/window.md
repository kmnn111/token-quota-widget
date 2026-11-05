# 窗口形态与「显示桌面」保活

窗口壳直接沿用云上晴雨天气台 / 云上会议的实战结论，规格对齐：

| | 大窗 | 吸顶小窗 |
|---|---|---|
| 尺寸 | 420 × 840 | 248 × 64 |
| 圆角 | 33px | 20px |
| 字体 | 31px 总量数字 / 10.5px 正文 | 17px 时间 / 10px 日期 / 9.5px 副标 / 44px 环形图 |

## 核心约束：窗口尺寸永不变

收起 / 展开 **不 resize 窗口**，只做两件事：

1. CSS `clip-path` 形变（240ms）——视觉过渡；
2. `win.setShape()` 裁剪——形状外不渲染、不接收鼠标。

原因：Win11 上透明窗做 resize 会出现白底闪、直角、卡顿，且 DPI 变化时会话位置漂移。

```js
// 大窗
setShape([{ x: 0, y: 0, width: 420, height: 840 }]);
// 吸顶：只保留小窗矩形
setShape([{ x: 86, y: 0, width: 248, height: 64 }]);
// CSS 同步
.frame.docked { clip-path: inset(0 86px 776px 86px round 20px); }
```

## 吸附判定

- 拖动结束（`moved` 事件）→ 距工作区顶边 ≤ 26px → `dockWindow()`
- 吸顶态拖离 > 90px → `undockWindow()`
- 程序改 bounds 后 600ms 内不判定，避免自己触发自己
- 最小化时窗口飞到 `-32000`，`b.y - wa.y` 会恒等于"贴顶"，必须 `if (win.isMinimized()) return`

## 「显示桌面」为什么不消失

Win+D / Win+M / 任务栏右下角小竖条，对 `skipTaskbar` 的工具窗 **既不最小化也不发事件**，而是把全屏壁纸 `WorkerW` 从 z 序底部跃升到普通窗口带顶端——非 topmost 的窗口会被壁纸盖住，窗口"健康"但用户看不见。

三保险：

### ① docked 态拦截系统最小化

```js
win.on('minimize', () => {
  if (!settings.docked) return;          // 大窗态保持系统正常行为
  setImmediate(undoMinimize);
  setTimeout(undoMinimize, 40);          // 动画期间再兜一次
  setTimeout(undoMinimize, 250);
});
// undoMinimize: showInactive（不抢焦点）→ moveTop → 重申层级 → 重申 shape
```

### ② 置顶开：screen-saver 级 topmost

```js
win.setAlwaysOnTop(true, 'screen-saver');
```

`screen-saver` 层天然免疫壁纸跃升，浮在最上层。

### ③ 置顶关：钉在壁纸层正上方（koffi / user32）

桌面部件语义——小窗平时沉在所有程序窗口之下，不挡任何软件；壁纸跃升时跟着浮到壁纸之上。

```js
// 每 100ms 重扫 WorkerW（class=WorkerW、w>1200、h>700）
// 可见者取最靠上（跃升态），全不可见取最靠下（常态）
// 注意：SetWindowPos(A, B) 是把 A 插到 B 下方，所以锚点取「壁纸层的上邻」
const anchor = A.getWindow(W, 3) || 0n;
A.setPos(hw, anchor, 0, 0, 0, 0, 0x1B); // NOSIZE|NOMOVE|NOSENDCHANGING|NOACTIVATE
```

细节：

- **不缓存句柄**：跃升 = 换位 + 变形，缓存必失手，每 tick 重扫、上限 2000（实测顶层窗口 1100+）
- **不按 DefView 过滤**：跃升后图标层搬进 WorkerW，按"无 DefView"筛会永远找不到
- 交互手感保留：聚焦 / 展开时允许自然置前，失焦 / 收起即归位

## 自检

```bash
npm run selftest
```

会真实调用 `Shell.Application.ToggleDesktop()`，分别在「置顶开」「置顶关」两种模式下检查 `isVisible() && !isMinimized()`：

```
[selftest] 置顶开（screen-saver 级 topmost）: visible=true minimized=false => PASS
[selftest] 置顶关（壁纸层 WorkerW 胶水）: visible=true minimized=false => PASS
[selftest] 汇总: ALL PASS
```

## 小窗内容与轮转

```
┌──────────────────────────────┐
│ 12:44 ³¹        ╭────╮       │
│ 11月5日 周四     │ 62 │       │  ← 环形图 = 剩余百分比（弧长 + 中心数字）
│ MiMo · 12时3分后 ╰────╯       │  ← 蓝色副标：厂商 + 重置倒计时
└──────────────────────────────┘
```

- 环形图 `r=17 / stroke-width=5 / 周长 106.8`，`stroke-dashoffset = C × (1 - left%)`，从 12 点方向顺时针填充
- 剩余 <20% 环与副标转琥珀；<10% 转朱红
- 配置 ≥2 家时每 `rotateSeconds`（默认 5s）轮转：副标 + 环形图一起横向滑入（340ms），时间日期固定不动
- 置顶厂商（MiMo）固定第一帧，其余按紧迫度排序
- 只有 1 家：完全静止，连分页点都不显示
- 悬停暂停轮转，移开恢复；分页点可手动切
- 某家登录态失效：只跳过该家，不打断其余轮转
