# -*- coding: utf-8 -*-
"""重试上传 v1.0.0 安装包资产（release 已建好，只补资产）。"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

REPO = 'kmnn111/token-quota-widget'
EXE = r'C:\Users\Administrator\WorkBuddy\2026-11-03-14-23-57\dingtalk-class-archiver\token-quota-widget\dist\TokenQuotaWidget-Setup-1.0.0.exe'
ASSET_NAME = 'TokenQuotaWidget-Setup-1.0.0.exe'


def get_pat():
    out = subprocess.run(
        ['git', 'credential', 'fill'],
        input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True, check=True
    ).stdout
    cred = dict(l.split('=', 1) for l in out.strip().splitlines() if '=' in l)
    return cred['password']


def api(pat, method, url, raw=None, ctype='application/json', timeout=60):
    headers = {'Authorization': f'Bearer {pat}', 'Accept': 'application/vnd.github+json',
               'User-Agent': 'token-quota-widget-release'}
    data = raw if raw is not None else None
    if raw is not None:
        headers['Content-Type'] = ctype
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

    st, rel = api(pat, 'GET', f'{base}/releases/tags/v1.0.0')
    assert st == 200, f'get release failed: {st} {rel}'
    print(f"release: {rel['html_url']}")

    # 清理同名残留资产
    for a in rel.get('assets', []):
        if a['name'] == ASSET_NAME:
            st, resp = api(pat, 'DELETE', f"{base}/releases/assets/{a['id']}")
            print(f'delete stale asset: {st}')

    upload_url = rel['upload_url'].split('{', 1)[0]
    with open(EXE, 'rb') as f:
        raw = f.read()
    print(f'uploading {len(raw)} bytes ...')
    st, resp = api(pat, 'POST', f'{upload_url}?name={ASSET_NAME}',
                   raw=raw, ctype='application/octet-stream', timeout=600)
    if st == 201:
        print(f"asset uploaded: {resp['browser_download_url']} size={resp['size']}")
    else:
        print(f'asset upload failed: {st} {resp}')
        sys.exit(1)


if __name__ == '__main__':
    main()
