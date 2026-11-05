# -*- coding: utf-8 -*-
"""把 design/logos/*.svg（simple-icons 官方图标）编译成 renderer/logos.js。
含厂商匹配表（正则 → 图标/品牌色/中文短名）+ 无官方图标厂商的品牌色文字标兜底。
用法： python design/gen-logos-js.py   →  renderer/logos.js
"""
import re, os, json

BASE = os.path.dirname(os.path.abspath(__file__))
LOGOS = os.path.join(BASE, 'logos')
OUT = os.path.join(os.path.dirname(BASE), 'renderer', 'logos.js')

# 匹配表：正则(不区分大小写，匹配厂商 name+id) / slug(None=文字标) / 品牌色 / 小窗短名
VENDORS = [
    (r'mimo|xiaomi|小米',            'xiaomi',      '#FF6900', '小米 MiMo'),
    (r'claude|anthropic',           'anthropic',   '#D97757', 'Claude'),
    (r'codex|openai|chatgpt|\bgpt\b','openai',      '#74AA9C', 'OpenAI Codex'),
    (r'gemini|google|\bbard\b',     'googlegemini','#8E75B2', 'Gemini 谷歌'),
    (r'deepseek|深度求索',           'deepseek',    '#5786FE', '深度求索'),
    (r'qwen|通义|千问|tongyi',       'qwen',        '#615CED', '通义千问'),
    (r'glm|zhipu|智谱|z\.?ai',      'zdotai',      '#3859FF', '智谱 GLM'),
    (r'kimi|moonshot|月之',         'kimi',        '#16191E', '月之暗面 Kimi'),
    (r'doubao|豆包|bytedance|字节',  'bytedance',   '#325AB4', '字节豆包'),
    (r'hunyuan|混元|tencent',       'tencenthy',   '#0052D9', '腾讯混元'),
    (r'ernie|文心|baidu|百度',       'baidu',       '#2932E1', '文心一言'),
    (r'minimax',                    'minimax',     '#1D2B36', 'MiniMax'),
    (r'meta|llama',                 'meta',        '#0866FF', 'Meta Llama'),
    (r'mistral',                    'mistralai',   '#FF7000', 'Mistral'),
    (r'perplexity',                 'perplexity',  '#20808D', 'Perplexity'),
    (r'ollama',                     'ollama',      '#000000', 'Ollama'),
    (r'nvidia|\bnim\b',             'nvidia',      '#76B900', 'NVIDIA'),
    (r'hugging|(^|\W)hf(\W|$)',     'huggingface', '#FFD21E', 'HuggingFace'),
    (r'alibaba|阿里',               'alibabacloud','#FF6A00', '阿里云'),
    # 无官方图标 → 文字标
    (r'grok|\bxai\b',               None, '#000000', 'xAI Grok',   'G'),
    (r'spark|星火|iflytek|讯飞',     None, '#2468F2', '讯飞星火',    '讯'),
    (r'step|阶跃',                  None, '#5B4EFF', '阶跃星辰',    '阶'),
    (r'baichuan|百川',              None, '#2E6CE6', '百川',       '百'),
]

def load_paths(slug):
    s = open(os.path.join(LOGOS, slug + '.svg'), encoding='utf-8').read()
    return re.findall(r'<path[^>]*?\sd="([^"]+)"', s)

paths = {}
for f in os.listdir(LOGOS):
    if f.endswith('.svg'):
        paths[f[:-4]] = load_paths(f[:-4])

data = {
    'paths': paths,
    'vendors': [dict(zip(('re', 'slug', 'brand', 'display', 'ch'), v)) for v in VENDORS],
}

js = '''/* logos.js — 厂商 logo 库（自动生成，勿手改；源头 design/gen-logos-js.py）
   simple-icons 官方图标 + 无官方图标厂商的品牌色文字标兜底。
   window.logoFor(name, fallbackColor) → { brand, display, svg } */
'use strict';
(function () {
  const DATA = %s;

  function letterArt(ch, brand) {
    return '<svg viewBox="0 0 24 24" height="42">' +
      '<rect x="1" y="1" width="22" height="22" rx="6.5" fill="' + brand + '"/>' +
      '<text x="12" y="16.8" text-anchor="middle" font-size="11.5" font-weight="700" ' +
      'fill="#ffffff" font-family="Microsoft YaHei, sans-serif">' + ch + '</text></svg>';
  }
  function markArt(paths, brand) {
    const d = (paths || []).map(p => '<path d="' + p + '" fill="' + brand + '"/>').join('');
    return '<svg viewBox="0 0 24 24" height="42">' + d + '</svg>';
  }
  function shortName(name) {
    let n = String(name || '').replace(/\\s*Token Plan\\s*/i, ' ').trim();
    if (!n) return '未知';
    const cjk = n.match(/[\\u4e00-\\u9fff]/);
    return n.length > 10 ? n.slice(0, 10) + '…' : n;
  }

  window.logoFor = function (name, fallbackColor) {
    const key = String(name || '');
    for (const v of DATA.vendors) {
      if (new RegExp(v.re, 'i').test(key)) {
        const brand = v.brand;
        const svg = v.slug ? markArt(DATA.paths[v.slug], brand) : letterArt(v.ch, brand);
        return { brand: brand, display: v.display, svg: svg };
      }
    }
    /* 兜底：首字符文字标 + 厂商自带颜色 */
    const brand = fallbackColor || '#7b8aa5';
    const m = key.match(/[\\u4e00-\\u9fff]/);
    const ch = m ? m[0] : (key.trim().charAt(0) || '?').toUpperCase();
    return { brand: brand, display: shortName(key), svg: letterArt(ch, brand) };
  };
})();
''' % json.dumps(data, ensure_ascii=False)

open(OUT, 'w', encoding='utf-8').write(js)
print('written', OUT, len(js), 'bytes,', len(paths), 'logos')
