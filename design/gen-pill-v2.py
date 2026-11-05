# -*- coding: utf-8 -*-
"""小窗胶囊 v2.1 预览页：解决 v2 的「logo 水印压环形图」问题。
三种摆法同屏对比：A 大水印贴左 / B logo 入列 / E 品牌色条；下方全阵容（方案 B）。
logo 来源 design/logos/*.svg（simple-icons 官方图标）；无官方图标的厂商用品牌色文字标兜底。
用法： python design/gen-pill-v2.py   →  design/pill-v2-preview.html
"""
import re, os

BASE = os.path.dirname(os.path.abspath(__file__))
LOGOS = os.path.join(BASE, 'logos')
OUT = os.path.join(BASE, 'pill-v2-preview.html')

def load(slug):
    s = open(os.path.join(LOGOS, slug + '.svg'), encoding='utf-8').read()
    title = re.search(r'<title>([^<]*)</title>', s)
    title = title.group(1) if title else slug
    fill = re.search(r'fill="(#[0-9A-Fa-f]{3,8})"', s)
    fill = fill.group(1) if fill else '#000000'
    paths = re.findall(r'<path[^>]*?\sd="([^"]+)"', s)
    return title, fill, paths

def rgba(hexstr, a):
    h = hexstr.lstrip('#')
    if len(h) == 3: h = ''.join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 'rgba(%d,%d,%d,%.3f)' % (r, g, b, a)

def logo_svg(slug, brand, h, color=None, cls='wslot'):
    _, _, paths = load(slug)
    c = color or brand
    d = ' '.join('<path d="%s" fill="%s"/>' % (p, c) for p in paths)
    return '<svg class="%s" viewBox="0 0 24 24" height="%d">%s</svg>' % (cls, h, d)

def letter_svg(ch, brand, h, color=None, cls='wslot', size=11.5):
    c = color or brand
    if color is None:  # 独立水印/入列形态：品牌色圆角方块 + 白字
        return ('<svg class="%s" viewBox="0 0 24 24" height="%d">'
                '<rect x="1" y="1" width="22" height="22" rx="6.5" fill="%s"/>'
                '<text x="12" y="16.8" text-anchor="middle" font-size="%s" font-weight="700" '
                'fill="#ffffff" font-family="Microsoft YaHei, sans-serif">%s</text></svg>') % (cls, h, brand, size, ch)
    # 色条形态：纯白字
    return ('<svg class="%s" viewBox="0 0 24 24" height="%d">'
            '<text x="12" y="17.5" text-anchor="middle" font-size="13" font-weight="700" '
            'fill="%s" font-family="Microsoft YaHei, sans-serif">%s</text></svg>') % (cls, h, c, ch)

# slug / 全名（A 用）/ 短名（B、E 用）/ 品牌色 / 演示剩余%
VENDORS = [
    ('xiaomi',      '小米 MiMo',           '小米 MiMo',      '#FF6900', 62),
    ('openai',      'OpenAI Codex',       'OpenAI Codex',   '#74AA9C', 12),
    ('anthropic',   'Anthropic Claude',   'Claude',         '#D97757', 78),
    ('googlegemini','Gemini 谷歌',         'Gemini 谷歌',     '#8E75B2', 45),
    ('deepseek',    '深度求索 DeepSeek',   '深度求索',        '#5786FE', 88),
    ('qwen',        '通义千问 Qwen',       '通义千问',        '#615CED', 34),
    ('zdotai',      '智谱 GLM · Z.ai',    '智谱 GLM',       '#3859FF', 71),
    ('kimi',        '月之暗面 Kimi',       '月之暗面 Kimi',    '#16191E', 56),
    ('bytedance',   '字节豆包 Doubao',     '字节豆包',        '#325AB4', 23),
    ('tencenthy',   '腾讯混元 Hunyuan',    '腾讯混元',        '#0052D9', 81),
    ('baidu',       '文心一言 ERNIE',      '文心一言',        '#2932E1', 39),
    ('minimax',     'MiniMax',            'MiniMax',        '#1D2B36', 64),
]
LETTERS = [
    ('G',  'xAI Grok',         'Grok',      '#000000', 52),
    ('讯', '科大讯飞星火 Spark', '讯飞星火',   '#2468F2', 67),
    ('阶', '阶跃星辰 Step',     '阶跃星辰',   '#5B4EFF', 31),
    ('百', '百川 Baichuan',     '百川',      '#2E6CE6', 84),
]

def ring_color(p):
    return '#3b9c8e' if p >= 50 else ('#d98a1f' if p >= 20 else '#d96a55')

RING = '''<svg class="pring" viewBox="0 0 44 44" width="44" height="44">
      <circle cx="22" cy="22" r="21" fill="rgba(255,255,255,.32)"/>
      <circle cx="22" cy="22" r="17" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="5"/>
      <circle cx="22" cy="22" r="17" fill="none" stroke="{rc}" stroke-width="5" stroke-linecap="round"
        stroke-dasharray="106.8" stroke-dashoffset="{off}" transform="rotate(-90 22 22)"/>
      <text x="22" y="26.3" text-anchor="middle" font-size="11.5" font-weight="700" fill="#22344f">{pct}</text>
    </svg>'''

def ring_html(pct):
    rc = ring_color(pct)
    return RING.format(rc=rc, off='%.1f' % (106.8 * (100 - pct) / 100), pct=pct)

def pmid_html(chip):
    return f'''<div class="pmid">
      <div class="ptime">12:47<sup>03</sup></div>
      <div class="pdate">11月5日 周四 · 5h 后重置</div>
      <div class="psubrow"><span class="chip">{chip}</span></div>
    </div>'''

def pill(variant, art, brand, chip, pct):
    """variant: A=大水印贴左 | B=logo 入列 | E=品牌色条 | old=现版本"""
    rc = ring_color(pct)
    chip_html = f'<span class="chip" style="color:{brand};background:{rgba(brand,0.13)}">{chip}</span>'
    pmid = f'''<div class="pmid">
      <div class="ptime">12:47<sup>03</sup></div>
      <div class="pdate">11月5日 周四 · 5h 后重置</div>
      <div class="psubrow">{chip_html}</div>
    </div>'''
    if variant == 'A':
        return f'<div class="pill">{art}{pmid}{ring_html(pct)}</div>'
    if variant == 'B':
        wash = 'background:linear-gradient(100deg, %s, rgba(255,255,255,.38) 62%%);' % rgba(brand, 0.12)
        return f'<div class="pill" style="{wash}">{pmid}{art}{ring_html(pct)}</div>'
    if variant == 'E':
        strip = f'<div class="strip" style="background:{rgba(brand,0.92)}">{art}</div>'
        return f'<div class="pill">{strip}{pmid}{ring_html(pct)}</div>'
    # old
    plain = f'<div class="psubrow"><div class="pplain">{chip} · 5h 后重置</div></div>'
    pmido = f'''<div class="pmid">
      <div class="ptime">12:47<sup>03</sup></div>
      <div class="pdate">11月5日 周四</div>{plain}</div>'''
    return f'<div class="pill old">{pmido}{ring_html(pct)}</div>'

def art_for(v, variant, letter=False):
    if letter:  # 文字标厂商
        ch, _full, _short, brand, _pct = v
        if variant == 'A':
            return letter_svg(ch, brand, 66, cls='wmA')
        if variant == 'E':
            return letter_svg(ch, brand, 24, color='#ffffff', cls='wslot', size=13)
        return letter_svg(ch, brand, 42, cls='wslot')
    slug, _full, _short, brand, _pct = v
    if variant == 'A':
        return logo_svg(slug, brand, 66, cls='wmA')
    if variant == 'E':
        return logo_svg(slug, brand, 24, color='#ffffff', cls='wslot')
    return logo_svg(slug, brand, 42, cls='wslot')

def chip_for(v, variant):
    return v[1] if variant == 'A' else v[2]

# ---------------- 对比区：3 厂商 × 3 摆法 ----------------
COMP_VENDORS = [(VENDORS[0], False), (VENDORS[4], False), (LETTERS[0], True)]  # 小米 / 深度求索 / Grok(文字标)
comp_rows = []
for v, isletter in COMP_VENDORS:
    cells = ''
    for variant, _label in (('A', ''), ('B', ''), ('E', '')):
        cells += f'<figure>{pill(variant, art_for(v, variant, isletter), v[3], chip_for(v, variant), v[4])}</figure>'
    comp_rows.append(f'<div class="comprow">{cells}</div>')

# ---------------- 全阵容（方案 B） ----------------
grid_cells = []
for v in VENDORS:
    grid_cells.append(
        f'<figure>{pill("B", art_for(v, "B"), v[3], v[2], v[4])}<figcaption>{v[1]}</figcaption></figure>')
letter_cells = []
for v in LETTERS:
    letter_cells.append(
        f'<figure>{pill("B", art_for(v, "B", True), v[3], v[2], v[4])}<figcaption>{v[1]} · 文字标兜底</figcaption></figure>')

html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>胶囊小窗 v2.1 方案预览</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    width: 900px; font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif; color: #5b4632;
    background:
      radial-gradient(420px 300px at 82% 6%, rgba(255, 178, 122, .55), transparent 70%),
      radial-gradient(380px 320px at 8% 30%, rgba(255, 205, 160, .5), transparent 70%),
      radial-gradient(460px 360px at 90% 62%, rgba(240, 150, 130, .42), transparent 70%),
      radial-gradient(420px 340px at 12% 88%, rgba(255, 190, 140, .45), transparent 70%),
      linear-gradient(160deg, #f9e6cc 0%, #f4cda9 45%, #eeb49b 78%, #e9a494 100%);
    padding: 30px 34px 34px;
  }}
  header h1 {{ font-size: 21px; font-weight: 700; letter-spacing: .5px; }}
  header p {{ font-size: 12px; margin-top: 6px; opacity: .82; line-height: 1.7; }}
  h2 {{ font-size: 13.5px; margin: 26px 0 6px; font-weight: 700; opacity: .85; }}
  .hint {{ font-size: 11px; opacity: .7; margin-bottom: 12px; }}
  .grid {{ display: grid; grid-template-columns: 248px 248px; gap: 22px 26px; justify-content: space-between; }}
  figure {{ display: flex; flex-direction: column; align-items: center; gap: 7px; }}
  figcaption {{ font-size: 11px; opacity: .78; letter-spacing: .2px; }}
  .comptable {{ display: flex; flex-direction: column; gap: 18px; }}
  .comprow {{ display: flex; gap: 26px; justify-content: space-between; }}
  .comphead {{ display: flex; gap: 26px; justify-content: space-between; margin-bottom: 4px; }}
  .comphead span {{ width: 224px; text-align: center; font-size: 11.5px; font-weight: 700; opacity: .85; }}
  .pill {{
    position: relative; width: 248px; height: 64px; border-radius: 20px; overflow: hidden;
    display: flex; align-items: center; gap: 8px; padding: 0 12px;
    background: rgba(255, 255, 255, .38);
    backdrop-filter: blur(26px) saturate(1.45); -webkit-backdrop-filter: blur(26px) saturate(1.45);
    border: 1px solid rgba(255, 255, 255, .5);
    box-shadow: 0 12px 30px rgba(40, 60, 90, .14);
  }}
  .pill.old {{ background: rgba(252, 250, 246, .82); border: 1px solid rgba(46, 66, 100, .13); padding: 0 15px; gap: 10px; }}
  .wmA {{ position: absolute; left: -15px; top: 50%; transform: translateY(-50%); opacity: .13; }}
  .wslot {{ flex: none; }}
  .strip {{
    flex: none; width: 44px; height: 52px; border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
  }}
  .pmid {{ display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }}
  .ptime {{ font-size: 17px; font-weight: 650; color: #22344f; line-height: 1.05; letter-spacing: .3px; }}
  .ptime sup {{ font-size: .42em; font-weight: 600; opacity: .68; margin-left: 2px; }}
  .pdate {{ font-size: 10px; color: #5b6e90; line-height: 1.25; white-space: nowrap; }}
  .psubrow {{ display: flex; align-items: center; height: 15px; }}
  .pplain {{ font-size: 9.5px; color: #3d6fd6; }}
  .chip {{ font-size: 9.5px; font-weight: 700; padding: 1.5px 7px; border-radius: 8px; white-space: nowrap; }}
  .pring {{ flex: none; }}
  .notes {{ margin-top: 26px; font-size: 11.5px; line-height: 1.9; opacity: .85; }}
</style>
</head>
<body>
  <header>
    <h1>胶囊小窗 · v2.1 方案预览</h1>
    <p>v2 的问题：logo 水印压着环形图显脏。v2.1 把 logo 从环形图脚下挪开，三种摆法同屏对比（同一厂商同一帧），选好后全阵容按所选拍法铺开。<br>
    logo 库已收录 {len(VENDORS) + len(LETTERS)} 家主流厂商（{len(VENDORS)} 家官方图标 + {len(LETTERS)} 家文字标兜底）。</p>
  </header>

  <h2>三种摆法对比</h2>
  <div class="hint">A：logo 大水印贴左缘裁切，压在时间文字后面（13% 透明），环形图完全干净 ｜ B：logo 入列成品牌小图标（全彩 42px），玻璃带品牌色渐变 ｜ E：左端品牌色条嵌 logo（白 logo），读数区更醒目</div>
  <div class="comptable">
    <div class="comphead"><span>A · 大水印贴左</span><span>B · logo 入列</span><span>E · 品牌色条</span></div>
    {''.join(comp_rows)}
  </div>

  <h2>全阵容 · 方案 B（logo 入列）</h2>
  <div class="grid">
    {''.join(grid_cells)}
  </div>

  <h2>没有官方图标的厂商 → 品牌色文字标自动兜底</h2>
  <div class="grid">
    {''.join(letter_cells)}
  </div>

  <div class="notes">
    <b>实现说明：</b>三种摆法都不再与环形图重叠；环形图下加了一层淡白托底，复杂壁纸上也能读。
    厂名徽标随品牌色着色（B/E 里为保证宽度用短名，完整名在大窗显示）；玻璃透明度维持 v2 的 38%。
  </div>
</body>
</html>'''

open(OUT, 'w', encoding='utf-8').write(html)
print('written', OUT, len(html), 'bytes')
