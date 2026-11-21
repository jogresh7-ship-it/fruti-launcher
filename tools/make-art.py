#!/usr/bin/env python3
"""Build launcher artwork from the pictures in covers/.

  python3 tools/make-art.py          -> art/<id>.webp (square tile) + art/<id>-hero.webp (wide banner)

Each cover (covers/<id>.jpg or .png, where <id> is the game id in games.js) is turned into:
  - a 480x480 tile: full-bleed if the picture is roughly square, otherwise the whole picture on top of a
    blurred copy of itself
  - a 1600x640 hero banner: the picture on the right, fading into a blurred backdrop on the left

The blur is baked into the files so the launcher never has to blur anything while it runs (that was the main
source of lag). Needs Pillow: pip install pillow
"""
import glob, os
from PIL import Image, ImageFilter, ImageEnhance

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = os.path.join(root, "art")
os.makedirs(out_dir, exist_ok=True)


def fill(im, w, h):
    """Scale and centre-crop im to exactly w x h."""
    s = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * s)), max(h, round(im.height * s))), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def fit(im, w, h):
    """Scale im to fit inside w x h."""
    s = min(w / im.width, h / im.height)
    return im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)


def backdrop(im, w, h, dark=0.55):
    small = fill(im, w // 8, h // 8).filter(ImageFilter.GaussianBlur(6))
    return ImageEnhance.Brightness(small.resize((w, h), Image.BILINEAR)).enhance(dark)


def tile(im, size=480):
    r = im.width / im.height
    if 0.74 <= r <= 1.36:
        return fill(im, size, size)
    bg = backdrop(im, size, size)
    fg = fit(im, size - 24, size - 24)
    bg.paste(fg, ((size - fg.width) // 2, (size - fg.height) // 2))
    return bg


def hero(im, w=1600, h=640):
    bg = backdrop(im, w, h, 0.45)
    fg = fill(im, min(w, round(h * max(im.width / im.height, 1.25))), h) if im.width >= im.height else fit(im, w, h - 80)
    x, y = w - fg.width, (h - fg.height) // 2
    # Fade the left edge of the picture into the backdrop
    fade = min(fg.width, 360)
    mask = Image.new("L", (fg.width, fg.height), 255)
    for i in range(fade):
        mask.paste(round(255 * (i / fade) ** 1.5), (i, 0, i + 1, fg.height))
    bg.paste(fg, (x, y), mask)
    return bg


count = 0
for src in sorted(glob.glob(os.path.join(root, "covers", "*"))):
    gid, ext = os.path.splitext(os.path.basename(src))
    if ext.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
        continue
    im = Image.open(src).convert("RGB")
    tile(im).save(os.path.join(out_dir, gid + ".webp"), quality=82, method=6)
    hero(im).save(os.path.join(out_dir, gid + "-hero.webp"), quality=78, method=6)
    count += 1
print(f"Wrote art for {count} covers to art/")
