# -*- coding: utf-8 -*-
"""创建 Release v1.1.0 并上传三件套：安装包 + .blockmap + latest.yml（OTA 必需）。"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

REPO = 'kmnn111/token-quota-widget'
TAG = 'v1.1.0'
DIST = r'C:\Users\Administrator\WorkBuddy\2026-11-03-14-23-57\dingtalk-class-archiver\token-quota-widget\dist'
ASSETS = [
    ('TokenQuotaWidget-Setup-1.1.0.exe', 'application/octet-stream'),
    ('TokenQuotaWidget-Setup-1.1.0.exe.blockmap', 'application/octet-stream'),
    ('latest.yml', 'text/yaml'),
]

BODY = """Windows 桌面 AI Token 额度仪表盘 v1.1.0。

**首页用量月历**：本月用量旁新增当月月历，按日 teal 强度着色、今天高亮、支持翻月；悬停日期弹出当日 tokens（带中文单位）/ 估算成本 / 会话·工具数 / 较前日 ±% / 占当月 %。

**OTA 在线更新**：内置在线更新（参照天气台机制）——设置页可手动检查 / 下载 / 重启安装，可自定义更新源；下载与安装都要用户确认；防回环 + 看门狗超时兜底 + 系统通知。本版起 Release 随包附 `latest.yml`，后续版本可直接在应用内收到更新。

**其他**：首页页脚版本号动态显示；逐日会话 / 工具数统计；点击回归 14 项全绿。

下载 `TokenQuotaWidget-Setup-1.1.0.exe` 安装即可（Windows x64）；老版本用户直接安装覆盖即可。
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
    pat = get_pat()
    base = f'https://api.github.com/repos/{REPO}'

    # 1. 创建 release（若已存在则复用）
    st, rel = api(pat, 'GET', f'{base}/releases/tags/{TAG}')
    if st == 404:
        st, rel = api(pat, 'POST', f'{base}/releases', {
            'tag_name': TAG,
            'name': '额度窗 v1.1.0 · 首页月历 + OTA 在线更新',
            'body': BODY,
            'draft': False,
            'prerelease': False,
        })
        assert st == 201, f'create release failed: {st} {rel}'
        print(f"created release {TAG}: {rel['html_url']}")
    else:
        assert st == 200, f'get release failed: {st} {rel}'
        print(f"release exists: {rel['html_url']}")
        st2, rel = api(pat, 'PATCH', f"{base}/releases/{rel['id']}", {'body': BODY, 'name': '额度窗 v1.1.0 · 首页月历 + OTA 在线更新'})
        print(f'update release body: {st2}')

    # 2. 上传三件套（清理同名残留）
    existing = {a['name']: a['id'] for a in rel.get('assets', [])}
    upload_url = rel['upload_url'].split('{', 1)[0]
    for name, ctype in ASSETS:
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
