# -*- coding: utf-8 -*-
"""把 shot-out/ 的 2x 截图合成到暖壁纸底，输出 .github/assets/showcase/。
配方：主图 = 截图四周 90px 壁纸边距；dock = 胶囊区域(x172..668,y0..128)裁切居中。
用法： python design/gen-showcase.py   （先 npm run shot）
"""
import os
from PIL import Image, ImageDraw, ImageFilter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(BASE, 'shot-out')
OUT = os.path.join(BASE, '.github', 'assets', 'showcase')

def warm_wallpaper(w, h):
    tiny = Image.new('RGB', (2, 2))
    tiny.putdata([(249, 230, 204), (250, 222, 192), (240, 190, 160), (233, 164, 148)])
    base = tiny.resize((w, h), Image.BICUBIC)
    blob = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(blob)
    r = int(w * 0.42)
    d.ellipse((w - r, -r // 2, w + r // 2, r), fill=(255, 178, 122, 110))
    d.ellipse((-r // 2, h - r, r, h + r // 2), fill=(255, 190, 140, 95))
    blob = blob.filter(ImageFilter.GaussianBlur(w * 0.09))
    base = Image.alpha_composite(base.convert('RGBA'), blob)
    return base

def compose(src, canvas_size, paste_at, out):
    shot = Image.open(src).convert('RGBA')
    canvas = warm_wallpaper(*canvas_size)
    canvas.alpha_composite(shot, paste_at)
    canvas.convert('RGB').save(out, quality=95)
    print('written', out, canvas.size)

os.makedirs(OUT, exist_ok=True)
M = 90
for name in ('main', 'limits'):
    compose(os.path.join(SHOT, name + '.png'), (1020, 1860), (M, M), os.path.join(OUT, name + '.png'))

# dock：2x 截图里胶囊占 (86..334, 0..64) DIP → (172..668, 0..128) px
shot = Image.open(os.path.join(SHOT, 'dock.png')).convert('RGBA')
pill = shot.crop((172, 0, 668, 128))
canvas = warm_wallpaper(912, 362)
canvas.alpha_composite(pill, ((912 - 496) // 2, (362 - 128) // 2))
canvas.convert('RGB').save(os.path.join(OUT, 'dock.png'), quality=95)
print('written', os.path.join(OUT, 'dock.png'), canvas.size)
