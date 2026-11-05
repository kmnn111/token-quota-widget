# -*- coding: utf-8 -*-
"""收敛版本历史：删除 v0.1.0/v0.2.0/v0.2.1 的 release+tag，创建单一 初始版 v1.0.0 并上传安装包。"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

REPO = 'kmnn111/token-quota-widget'
OLD = ['v0.1.0', 'v0.2.0', 'v0.2.1']
NEW_TAG = 'v1.0.0'
EXE = r'C:\Users\Administrator\WorkBuddy\2026-11-03-14-23-57\dingtalk-class-archiver\token-quota-widget\dist\TokenQuotaWidget-Setup-1.0.0.exe'

BODY = """Windows 桌面 AI Token 额度仪表盘 · 初始版。

**形态**：420×840 玻璃主窗 ⇄ 280×64 吸顶胶囊小窗；20 家厂商 logo 库；默认桌面部件语义（不盖住其他程序，可手动置顶）；Win+D 保活三保险。

**数据**：MiMo Token Plan 双通道 + 真实周期套餐标签；本机用量（今日/本月/累计 + 30 天活跃度）；自定义端点；演示数据开箱可见。

**AI 热榜**：国人开源项目优先；中文一句话简介（腾讯 TranSmart 三通道翻译）；日榜风格概括 + 上手摩擦标签（打开就用 / 一条命令 / 要配环境）。

**质量与安全**：真实点击回归 + selftest；rAF 合帧拖拽；失败静默兜底；凭据只存本机并打码。

下载 `TokenQuotaWidget-Setup-1.0.0.exe` 安装即可（Windows x64）。
"""


def get_pat():
    out = subprocess.run(
        ['git', 'credential', 'fill'],
        input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True, check=True
    ).stdout
    cred = dict(l.split('=', 1) for l in out.strip().splitlines() if '=' in l)
    return cred['password']


def api(pat, method, url, payload=None, raw=None, ctype='application/json'):
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
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            return r.status, (json.loads(body) if body and 'json' in r.headers.get('Content-Type', '') else body)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


def main():
    pat = get_pat()
    base = f'https://api.github.com/repos/{REPO}'

    # 1. 列出现有 release，删除旧版
    st, releases = api(pat, 'GET', f'{base}/releases?per_page=50')
    assert st == 200, f'list releases failed: {st} {releases}'
    for rel in releases:
        tag = rel.get('tag_name')
        if tag in OLD:
            st, resp = api(pat, 'DELETE', f"{base}/releases/{rel['id']}")
            print(f"delete release {tag}: {st}")
            # 删 tag
            st, resp = api(pat, 'DELETE', f'{base}/git/refs/tags/{tag}')
            print(f"delete tag {tag}: {st}")
        else:
            print(f"keep release: {tag}")

    # 2. 兜底删残留 tag
    for tag in OLD:
        st, resp = api(pat, 'DELETE', f'{base}/git/refs/tags/{tag}')
        if st != 404:
            print(f"delete leftover tag {tag}: {st}")

    # 3. 创建 v1.0.0 release
    st, rel = api(pat, 'POST', f'{base}/releases', {
        'tag_name': NEW_TAG,
        'name': '初始版 v1.0.0',
        'body': BODY,
        'draft': False,
        'prerelease': False,
    })
    assert st == 201, f'create release failed: {st} {rel}'
    print(f"created release {NEW_TAG}: {rel['html_url']}")

    # 4. 上传资产（ASCII 资产名）
    upload_url = rel['upload_url'].split('{', 1)[0]
    with open(EXE, 'rb') as f:
        raw = f.read()
    print(f'exe size: {len(raw)} bytes')
    st, resp = api(pat, 'POST', f'{upload_url}?name=TokenQuotaWidget-Setup-1.0.0.exe',
                   raw=raw, ctype='application/octet-stream')
    if st == 201:
        print(f"asset uploaded: {resp['browser_download_url']}")
    else:
        print(f'asset upload failed: {st} {resp}')
        sys.exit(1)


if __name__ == '__main__':
    main()
