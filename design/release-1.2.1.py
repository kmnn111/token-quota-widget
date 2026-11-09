# -*- coding: utf-8 -*-
"""创建 Release v1.2.1 并上传三件套：安装包 + .blockmap + latest.yml（OTA 必需）。"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

REPO = 'kmnn111/token-quota-widget'
TAG = 'v1.2.1'
NAME = '额度窗 v1.2.1 · 热修吸顶悬停展开失灵'
DIST = r'C:\Users\Administrator\WorkBuddy\2026-11-03-14-23-57\dingtalk-class-archiver\token-quota-widget\dist'
ASSETS = [
    ('TokenQuotaWidget-Setup-1.2.1.exe', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.2.1.exe.blockmap', 'application/octet-stream'),
    ('latest.yml', 'text/yaml'),
    # 1.2.0 用户首次 OTA 时 electron-updater 会来服务器取上一版 blockmap 走差分下载；
    # 补上它才省 82MB 全量流量，缺了则 404 退化为全量下载。
    ('TokenQuotaWidget-Setup-1.2.0.exe.blockmap', 'application/octet-stream'),
]

BODY = """Windows 桌面 AI Token 额度仪表盘 v1.2.1 —— **热修版**，修一处吸顶小窗悬停展开的回归。

## 修复（来自 v1.2.0 反馈）
- **吸顶小窗「鼠标滑过自动变大窗、移开收小窗」失灵**：根因是展开判定只靠主进程每 260ms 比对「屏幕光标坐标 vs 窗口 bounds」，高 DPI / 多屏下两者口径容易错位；更致命的是 `edgeDock`（顶部吸附开关）被误当成「禁用悬停展开」，关掉该开关后检测直接短路不跑，出现「小窗形状还在、检测没启动」的死状态。
- 改法：#frame 在吸顶态被 clip-path 裁成胶囊，命中区域与窗口 region 一致，直接绑 DOM `mouseenter/mouseleave` 上报主进程；主进程收到首个 DOM 事件即停掉坐标轮询（两套判定不再打架抖动），真实滑入即展开；坐标轮询降级为页面未上报时的兜底；`edgeDock` 不再短路悬停；处于吸顶态即启用检测，页面重载后补启。
- 新增 `--hover-test` 全链路自检 6 项 ALL PASS（滑入展开 → 移开收起 → 重复展开 → 关闭顶部吸附仍生效）。

v1.2.0 的全部新功能（近 7 日趋势、月历小结与点击钉住、CSV 导出、额度预警、跟随系统主题）与 BUG 修复、流畅度收尾均包含在本版中。

**升级**：已装任意旧版的用户，在「设置 → 软件更新」点「检查更新」即可下载安装（下载 / 安装均需你确认）；也可下载下方 `TokenQuotaWidget-Setup-1.2.1.exe` 覆盖安装（Windows x64）。
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
