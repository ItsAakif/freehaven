"""Generate three synthetic 'scanned' pages for OCR evaluation.

They are not real scanner output; they model the three failure modes we care
about: clean print, low-contrast/rotated, and dense two-column text.
Ground truth is exact by construction.
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os, json, math

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "ocr-fixtures")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

BODY = (
    "Attention is the mind's selective hold on one object at the expense of others. "
    "William James described it as withdrawal from some things in order to deal effectively with others. "
    "The metaphor is useful because it treats focus as a budget rather than a switch. "
    "Every additional demand on that budget makes the remaining work shallower and slower. "
    "A quiet room is not a luxury; it is a reduction in the number of competing bids for the same resources. "
    "Designing the environment is therefore a more reliable strategy than relying on willpower alone."
)

BODY2 = (
    "Habit begins as a deliberate choice and ends as a background process. "
    "A cue opens the sequence, a routine carries it, and a reward closes the loop. "
    "Because the cue is usually environmental, changing the room changes the behaviour more reliably than changing the intention. "
    "People who appear disciplined often have simply arranged their surroundings so that the desired action is the easiest one available. "
    "The practical question is not how to want something more, but how to make it require less friction."
)

BODY3 = (
    "Memory is reconstructive rather than photographic. "
    "Each retrieval reopens a trace and writes it down again with the context of the present moment. "
    "That is why confident recollection can still be mistaken, and why re-reading feels fluent without producing durable knowledge. "
    "Retrieval practice is harder and feels less productive, yet it strengthens the trace precisely because it requires effort. "
    "Spacing those attempts across days gives the system time to forget a little, which is the condition under which the next attempt is useful."
)

COL1 = (
    "A library is an argument about what deserves to be remembered. "
    "Selection is never neutral: every shelf excludes more than it includes. "
    "The useful question is not whether a canon exists, but who assembled it, for what purpose, and what it leaves out. "
    "Reading widely is not the same as reading indiscriminately. "
    "A good list gives you a sequence, a reason for the sequence, and permission to stop."
)

COL2 = (
    "Notes are only valuable when they can be found again. "
    "A note without a source is a rumour; a note without a question is a transcription. "
    "The strongest notes record the claim, the evidence, and the disagreement it provoked. "
    "Linking two notes is often more useful than adding a third. "
    "Over time the graph of links becomes the real document, and the original text becomes its evidence base."
)


def font(size, serif=True):
    candidates = [
        r"C:\Windows\Fonts\georgia.ttf" if serif else r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\times.ttf" if serif else r"C:\Windows\Fonts\arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def wrap(draw, text, fnt, width):
    words, lines, line = text.split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=fnt) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def page(draw, draw_lines, fnt, leading, margin=100, color=20):
    for y, line in draw_lines:
        draw.text((margin, y), line, font=fnt, fill=color)


def doc_clean():
    img = Image.new("L", (1700, 2200), 255)
    d = ImageDraw.Draw(img)
    f = font(34)
    lines = wrap(d, f"{BODY} {BODY2} {BODY3}", f, 1500)
    draw_lines = [(120 + i * 52, line) for i, line in enumerate(lines[:40])]
    page(d, draw_lines, f, 52)
    d.text((120, 2050), "Page 1", font=font(26), fill=60)
    img.save(os.path.join(OUT, "clean.png"))
    return " ".join(lines[:40])


def doc_lowcontrast():
    img = Image.new("L", (1700, 2200), 246)
    d = ImageDraw.Draw(img)
    f = font(32)
    lines = wrap(d, f"{BODY} {BODY2} {BODY3}", f, 1450)
    draw_lines = [(120 + i * 50, line) for i, line in enumerate(lines[:38])]
    page(d, draw_lines, f, 50, color=120)
    img = img.rotate(1.4, resample=Image.BICUBIC, fillcolor=246)
    img = img.filter(ImageFilter.GaussianBlur(0.8))
    img.save(os.path.join(OUT, "lowcontrast_skew.png"), quality=55)
    return " ".join(lines[:38])


def doc_columns():
    img = Image.new("L", (1700, 2200), 252)
    d = ImageDraw.Draw(img)
    f = font(22)
    left = wrap(d, f"{COL1} {BODY2}", f, 690)
    right = wrap(d, f"{COL2} {BODY3}", f, 690)
    for i, line in enumerate(left[:56]):
        d.text((90, 100 + i * 34), line, font=f, fill=25)
    for i, line in enumerate(right[:56]):
        d.text((910, 100 + i * 34), line, font=f, fill=25)
    img = img.filter(ImageFilter.GaussianBlur(0.4))
    img.save(os.path.join(OUT, "dense_columns.png"))
    return " ".join(left[:56] + right[:56])


if __name__ == "__main__":
    truth = {
        "clean.png": doc_clean(),
        "lowcontrast_skew.png": doc_lowcontrast(),
        "dense_columns.png": doc_columns(),
    }
    with open(os.path.join(OUT, "ground-truth.json"), "w", encoding="utf-8") as fh:
        json.dump(truth, fh, indent=2)
    print("wrote fixtures to", OUT)
    for name, text in truth.items():
        print(name, len(text), "chars")
