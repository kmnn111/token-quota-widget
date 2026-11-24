# -*- coding: utf-8 -*-
"""创建 Release v1.2.2 并上传四件套：安装包 + .blockmap + latest.yml + 旧版 blockmap（OTA 必需）。"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

REPO = 'kmnn111/token-quota-widget'
TAG = 'v1.2.2'
NAME = '额度窗 v1.2.2 · 新增 Google AI 本机遇额源'
DIST = r'C:\Users\Administrator\WorkBuddy\2026-11-03-14-23-57\dingtalk-class-archiver\token-quota-widget\dist'
ASSETS = [
    ('TokenQuotaWidget-Setup-1.2.2.exe', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.2.2.exe.blockmap', 'application/octet-stream'),
    ('latest.yml', 'text/yaml'),
    # 旧版用户 OTA 时 electron-updater 会取自己版本的 blockmap 做差分下载；
    # 缺了则 404 退化为 82MB 全量下载。
    ('TokenQuotaWidget-Setup-1.2.1.exe.blockmap', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.2.0.exe.blockmap', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.1.0.exe.blockmap', 'application/octet-stream'),
]

BODY = """Windows 桌面 AI Token 额度仪表盘 v1.2.2 —— 新增 **Google AI 本机遇额源**，同时修正 credits 单位显示。界面文字、标签与图标已统一为 Google AI / Gemini 星标。

## 新功能
- **Google AI 数据源**：设置 → 数据源 → 类型选「Google AI（本机额度）」，添加后自动读取本机额度，无需登录或填密钥
  - 显示三项额度：**AI Credits 月余额** + 各模型组的 **5 小时滚动剩余** / **每周剩余**（字段随版本弹性识别，能取到几个显示几个）
  - 自动补全模型与主模型共享额度，自动跳过不重复计数
  - 端口与 csrfToken 自动发现，高级用户可手动指定端口
  - 应用未运行时卡片优雅显示「Google AI 未运行」，不影响其他数据源
- 小窗支持**多数据源轮播**：Google AI 与 MiMo 各占一帧，默认 5 秒切换，可点分页点手动切；悬停暂停、滑入展开大窗、移开收回
- 置顶卡按配置顺序展示第一家，其他厂商在「额度」列表里完整列出各自的额度窗

## 修正
- credits / 余额类额度显示整数千分位（如 `380 / 1,000`），不再错套 token 的 K/M 单位
- 吸顶小窗悬停展开沿用 v1.2.1 的 DOM 事件方案，高 DPI / 多屏下不再失灵

**升级**：已装任意旧版的用户，在「设置 → 软件更新」点「检查更新」即可下载安装（下载 / 安装均需你确认）；也可直接下载下方 `TokenQuotaWidget-Setup-1.2.2.exe` 覆盖安装（Windows x64）。
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
