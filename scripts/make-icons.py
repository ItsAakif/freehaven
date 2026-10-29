"""Generate Freehaven brand assets: an arch (haven) with a rising mark inside."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "images")
OUT = os.path.abspath(OUT)
S = 2048  # supersample
PAPER = (246, 241, 231, 255)
INK = (47, 93, 80, 255)
GOLD = (192, 138, 62, 255)


def draw_mark(size: int, fg=INK, bg=None, padding=0.20, include_gold=True):
    img = Image.new("RGBA", (size, size), bg if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * padding
    left, right = pad, size - pad
    top = pad
    bottom = size - pad
    w = max(6, int(size * 0.030))
    cx = size / 2

    # Arch: semicircle + two legs, open at the bottom = a harbour gateway.
    radius = (right - left) / 2
    d.arc([left, top, right, top + 2 * radius], start=180, end=360, fill=fg, width=w)
    d.line([(left, top + radius), (left, bottom - size * 0.06)], fill=fg, width=w)
    d.line([(right, top + radius), (right, bottom - size * 0.06)], fill=fg, width=w)

    # Horizon inside the arch.
    hy = top + radius + (bottom - top - radius) * 0.42
    inset = size * 0.085
    d.line([(left + inset, hy), (right - inset, hy)], fill=fg, width=max(4, int(w * 0.55)))

    # Rising mark (sun / idea) above the horizon.
    r = size * 0.055
    cy = hy - r - size * 0.045
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD if include_gold else fg)

    # Small reflection below the horizon.
    if include_gold:
        d.ellipse([cx - r * 0.5, hy + size * 0.035 - r * 0.5, cx + r * 0.5, hy + size * 0.035 + r * 0.5], fill=(192, 138, 62, 120))
    return img


def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))


def main():
    os.makedirs(OUT, exist_ok=True)
    # App icon: full-bleed paper background.
    icon = draw_mark(S, bg=PAPER, padding=0.22)
    save(icon, "icon.png", 1024)
    save(icon, "favicon.png", 64)

    # Android adaptive: foreground with safe-zone padding, solid background layer.
    fg = draw_mark(S, padding=0.30)
    save(fg, "android-icon-foreground.png", 1024)
    bg = Image.new("RGBA", (S, S), PAPER)
    save(bg, "android-icon-background.png", 1024)
    save(bg, "android-icon-monochrome.png", 1024) if False else None
    mono = draw_mark(S, fg=(255, 255, 255, 255), bg=(0, 0, 0, 0), padding=0.30, include_gold=False)
    save(mono, "android-icon-monochrome.png", 1024)

    # Splash mark on the paper background is handled by Expo; ship a transparent mark.
    splash = draw_mark(S, padding=0.18)
    save(splash, "splash-icon.png", 512)

    # Social/OG-ish square for documentation.
    save(icon, "brand-card.png", 512)
    print("wrote icons to", OUT)


if __name__ == "__main__":
    main()

