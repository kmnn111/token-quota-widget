# -*- coding: utf-8 -*-
"""创建 Release v1.2.3 并上传四件套：安装包 + .blockmap + latest.yml + 旧版 blockmap（OTA 必需）。"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

REPO = 'kmnn111/token-quota-widget'
TAG = 'v1.2.3'
NAME = '额度窗 v1.2.3 · Google AI 取消告急 + 小窗平移切换'
DIST = r'C:\Users\Administrator\WorkBuddy\2026-11-03-14-23-57\dingtalk-class-archiver\token-quota-widget\dist'
ASSETS = [
    ('TokenQuotaWidget-Setup-1.2.3.exe', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.2.3.exe.blockmap', 'application/octet-stream'),
    ('latest.yml', 'text/yaml'),
    # 旧版用户 OTA 时 electron-updater 会取自己版本的 blockmap 做差分下载；
    # 缺了则 404 退化为 82MB 全量下载。
    ('TokenQuotaWidget-Setup-1.2.2.exe.blockmap', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.2.1.exe.blockmap', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.2.0.exe.blockmap', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.1.0.exe.blockmap', 'application/octet-stream'),
]

BODY = """Windows 桌面 AI Token 额度仪表盘 v1.2.3 —— 修正 Google AI 订阅会员的「告急」误报，并升级小窗切换动效。

## 修正
- **Google AI 不再触发「额度告急」**：AI Credits / 5 小时 / 周额度数字照常显示，但不再推系统通知、状态栏不再亮「有额度临界」、小窗 chip 与圆环不再转琥珀、列表数字不再标红。其他按量数据源的临界提醒保持不变。
- **小窗轮播改为左右平移**：新帧从右滑入、旧帧向左淡出；点前一个分页点则反向。用合成器动画跑（transform/opacity，不触发重排），连点先取消上一帧，幽灵层不堆叠，并遵循系统「减少动效」设置。

v1.2.2 的 Google AI 本机遇额源、credits 千分位显示、悬停展开修复均包含在本版中。

**升级**：已装任意旧版的用户，在「设置 → 软件更新」点「检查更新」即可下载安装（下载 / 安装均需你确认）；也可直接下载下方 `TokenQuotaWidget-Setup-1.2.3.exe` 覆盖安装（Windows x64）。
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
    only = None
    for a in sys.argv[1:]:
        if a.startswith('--only='):
            only = a.split('=', 1)[1]
    pat = get_pat()
    base = f'https://api.github.com/repos/{REPO}'

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
        st2, _ = api(pat, 'PATCH', f"{base}/releases/{rel['id']}", {'body': BODY, 'name': NAME})
        print(f'update release body: {st2}')
        st, rel = api(pat, 'GET', f"{base}/releases/{rel['id']}")
        assert st == 200, f'refetch release failed: {st} {rel}'

    existing = {a['name']: a['id'] for a in rel.get('assets', [])}
    upload_url = rel['upload_url'].split('{', 1)[0]
    for name, ctype in ASSETS:
        if only and name != only:
            continue
        if name in existing:
            st, _ = api(pat, 'DELETE', f"{base}/releases/assets/{existing[name]}")
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
