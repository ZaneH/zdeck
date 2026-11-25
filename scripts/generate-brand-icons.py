#!/usr/bin/env python3
"""Regenerate boxed-Z assets: python3 scripts/generate-brand-icons.py (Pillow required)."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public/icons"
NATIVE = ROOT / "src-tauri/icons"
SHAPES = '''  <rect x="3.5" y="3.5" width="25" height="25" rx="6" fill="none" stroke="{ink}" stroke-width="1.5"/>
  <path d="M10 11h12L10 21h12" fill="none" stroke="{ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'''


def mask(size):
    # Supersample so small favicons and the tray retain smooth rounded strokes.
    scale = size * 4 / 32
    image = Image.new("L", (size * 4, size * 4))
    draw = ImageDraw.Draw(image)
    # Pillow's outline sits inside its bounds; SVG strokes straddle the path.
    draw.rounded_rectangle(tuple(v * scale for v in (2.75, 2.75, 29.25, 29.25)),
                           radius=6.75 * scale, fill=255)
    draw.rounded_rectangle(tuple(v * scale for v in (4.25, 4.25, 27.75, 27.75)),
                           radius=5.25 * scale, fill=0)
    points = [(10, 11), (22, 11), (10, 21), (22, 21)]
    draw.line([(x * scale, y * scale) for x, y in points],
              fill=255, width=round(2.4 * scale))
    for x, y in points:
        draw.ellipse(((x - 1.2) * scale, (y - 1.2) * scale,
                      (x + 1.2) * scale, (y + 1.2) * scale), fill=255)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def gradient(size, start, end):
    image = Image.new("RGBA", (size, size))
    image.putdata([
        tuple(round(a + (b - a) * (x + y) / (2 * (size - 1)))
              for a, b in zip(start, end)) + (255,)
        for y in range(size) for x in range(size)
    ])
    return image


svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="zDeck">\n'
defs = '''  <defs>
    <linearGradient id="background" x2="1" y2="1">
      <stop stop-color="#141b24"/><stop offset="1" stop-color="#07090c"/>
    </linearGradient>
    <linearGradient id="accent" x2="1" y2="1">
      <stop stop-color="#6fe1ff"/><stop offset="1" stop-color="#239bc9"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" fill="url(#background)"/>
'''
(PUBLIC / "icon.svg").write_text(svg + defs + SHAPES.format(ink="url(#accent)") + "\n</svg>\n")
(NATIVE / "tray-template.svg").write_text(svg + SHAPES.format(ink="#000") + "\n</svg>\n")

app = gradient(1024, (20, 27, 36), (7, 9, 12))
app.paste(gradient(1024, (111, 225, 255), (35, 155, 201)), (0, 0), mask(1024))
outputs = {
    PUBLIC / "apple-touch-icon.png": 180,
    PUBLIC / "favicon-32.png": 32,
    PUBLIC / "icon-192.png": 192,
    PUBLIC / "icon-512.png": 512,
    NATIVE / "32x32.png": 32,
    NATIVE / "128x128.png": 128,
    NATIVE / "128x128@2x.png": 256,
    NATIVE / "icon.png": 1024,
}
for path, size in outputs.items():
    app.resize((size, size), Image.Resampling.LANCZOS).save(path)
tray = Image.new("RGBA", (44, 44))
tray.putalpha(mask(44))
tray.save(NATIVE / "tray-template.png")
app.save(NATIVE / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
app.save(NATIVE / "icon.icns")

# Check the encoded files, not just the in-memory images.
outputs[NATIVE / "tray-template.png"] = 44
for path, size in outputs.items():
    with Image.open(path) as image:
        assert image.size == (size, size) and image.mode == "RGBA", path
        if path.name == "tray-template.png":
            assert image.getchannel("A").getextrema() == (0, 255)
            assert image.getpixel((0, 0))[3] == image.getpixel((22, 10))[3] == 0
            assert all(image.getchannel(c).getextrema() == (0, 0) for c in "RGB")
        print(f"{path.relative_to(ROOT)}: {size}x{size} RGBA OK")
with Image.open(NATIVE / "icon.ico") as image:
    assert image.ico.sizes() == {(s, s) for s in (16, 24, 32, 48, 64, 128, 256)}
    print("src-tauri/icons/icon.ico: 7 sizes, 16–256 OK")
with Image.open(NATIVE / "icon.icns") as image:
    assert image.size == (1024, 1024)
    print("src-tauri/icons/icon.icns: 1024x1024 OK")
