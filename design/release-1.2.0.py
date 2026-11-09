# -*- coding: utf-8 -*-
"""创建 Release v1.2.0 并上传三件套：安装包 + .blockmap + latest.yml（OTA 必需）。"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

REPO = 'kmnn111/token-quota-widget'
TAG = 'v1.2.0'
NAME = '额度窗 v1.2.0 · 近 7 日趋势 / 导出 / 预警 + 细节打磨'
DIST = r'C:\Users\Administrator\WorkBuddy\2026-11-03-14-23-57\dingtalk-class-archiver\token-quota-widget\dist'
ASSETS = [
    ('TokenQuotaWidget-Setup-1.2.0.exe', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.2.0.exe.blockmap', 'application/octet-stream'),
    ('latest.yml', 'text/yaml'),
    # 老用户首次 OTA 时若本地无缓存，electron-updater 会来服务器取上一版 blockmap；
    # 补上它才能走差分下载（省流量），缺了则 404 退化为 82MB 全量下载。
    ('TokenQuotaWidget-Setup-1.1.0.exe.blockmap', 'application/octet-stream'),
]

BODY = """Windows 桌面 AI Token 额度仪表盘 v1.2.0 —— 细节打磨版，也是**首个可通过应用内 OTA 直接升级**的版本。

## 新功能
- **近 7 日趋势**：首页左栏迷你柱状图（7 日用量 + 合计 + 较前 7 日环比），与右侧当月月历形成「近 7 日 / 当月」互补
- **月历月度小结 + 点击钉住**：卡底显示本月合计 / 日均 / 峰值日；点击日期把详情浮层固定，再点或点卡外关闭，峰值日带小圆点
- **导出当月用量 CSV**：设置页一键导出逐日 tokens / 估算成本 / 会话数 / 工具数，BOM + 中文表头，Excel 双击不乱码
- **额度临界系统通知**：低于阈值（默认 10%，可设 1–50%）推一次，按「源 + 额度窗 + 当天」落盘去重，重启不复发，演示数据不触发
- **主题跟随系统** + 状态栏「x 分钟前刷新」数据新鲜度

## BUG 修复
- 刷新间隔原先要重启才生效，现即改即生效；负数 / 超大值统一钳制
- 数据刷新把小窗轮播打回第一帧；热榜「本周」重启回退；自定义更新源不回显 / 非法 URL 误报成功
- OTA 陈旧横幅不收起、连点检查 / 更新重复发请求；月历翻月高度跳动与浮层残留
- 托盘勾选不同步、颜色 / 余额 / 错误信息未转义、脏数据显示 `NaN`、设置项改白名单写入、添加 / 删除连点加锁

## 流畅度与健壮性
时钟不再每秒重建 DOM（仅小窗秒级刷新、隐藏时暂停）；隐藏视图不重绘、切回补画；月历 / 热榜改事件委托（42 格只 3 个监听器）；轮播动画 3 次强制 reflow 合 1 次；窗口隐藏停网络轮询且 Win+D 保活不误触发；浮层过渡显隐、统一禁用态、`prefers-reduced-motion` 支持。

回归：13 文件语法检查 + 真实点击 32 项 + OTA 假源全链路 + Win+D 保活自检 + 六视图截图，全部 PASS。

**升级**：已装 v1.1.0 的用户可在「设置 → 软件更新」点「检查更新」直接下载安装；也可下载下方 `TokenQuotaWidget-Setup-1.2.0.exe` 覆盖安装（Windows x64）。
"""


def get_pat():
    out = subprocess.run(
        ['git', 'credential', 'fill'],
        input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True, check=True
    ).stdout
    cred = dict(l.split('=', 1) for l in out.strip().splitlines() if '=' in l)
    return cred['password']


def api(pat, method, url, payload=None, raw=None, ctype='application/json', timeout=60):
    headers = {'Authorization': f'Bearer {pat}', 'Accept': 'application/vnd.github+json',
               'User-Agent': 'token-quota-widget-release'}
    data = None
    if raw is not None:
        data = raw
        headers['Content-Type'] = ctype
    elif payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, (json.loads(body) if body and 'json' in r.headers.get('Content-Type', '') else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


def main():
    # 支持 --only=<资产名>：补传单个资产，避免重传 82MB 安装包
    only = None
    for a in sys.argv[1:]:
        if a.startswith('--only='):
            only = a.split('=', 1)[1]
    pat = get_pat()
    base = f'https://api.github.com/repos/{REPO}'

    # 1. 创建 release（若已存在则复用并更新文案）
    st, rel = api(pat, 'GET', f'{base}/releases/tags/{TAG}')
    if st == 404:
        st, rel = api(pat, 'POST', f'{base}/releases', {
            'tag_name': TAG,
            'name': NAME,
            'body': BODY,
            'draft': False,
            'prerelease': False,
        })
        assert st == 201, f'create release failed: {st} {rel}'
        print(f"created release {TAG}: {rel['html_url']}")
    else:
        assert st == 200, f'get release failed: {st} {rel}'
        print(f"release exists: {rel['html_url']}")
        st2, rel2 = api(pat, 'PATCH', f"{base}/releases/{rel['id']}", {'body': BODY, 'name': NAME})
        print(f'update release body: {st2}')
        st, rel = api(pat, 'GET', f"{base}/releases/{rel['id']}")
        assert st == 200, f'refetch release failed: {st} {rel}'

    # 2. 上传三件套（清理同名残留）
    existing = {a['name']: a['id'] for a in rel.get('assets', [])}
    upload_url = rel['upload_url'].split('{', 1)[0]
    for name, ctype in ASSETS:
        if only and name != only:
            continue
        if name in existing:
            st, resp = api(pat, 'DELETE', f"{base}/releases/assets/{existing[name]}")
            print(f'delete stale asset {name}: {st}')
        with open(f'{DIST}\\{name}', 'rb') as f:
            raw = f.read()
        print(f'uploading {name}: {len(raw)} bytes ...')
        st, resp = api(pat, 'POST', f'{upload_url}?name={name}',
                       raw=raw, ctype=ctype, timeout=600)
        if st == 201:
            print(f"  ok: {resp['browser_download_url']} size={resp['size']}")
        else:
            print(f'  FAILED: {st} {resp}')
            sys.exit(1)

    print('ALL ASSETS UPLOADED')


if __name__ == '__main__':
    main()
