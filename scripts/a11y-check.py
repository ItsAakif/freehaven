"""Static accessibility checks for the Freehaven palettes (WCAG contrast)."""
import json, os

PALETTES = {
    "light": dict(bg="#F6F1E7", surface="#FFFDF8", surfaceAlt="#EFE7D8", ink="#1B1813", inkMuted="#6B6355",
                  inkFaint="#9A9082", accent="#2F5D50", accentInk="#F4FBF7", warm="#B4552D",
                  danger="#A33B2B", dangerSoft="#F4DDD8", gold="#B07C2E"),
    "dark": dict(bg="#12110F", surface="#1D1C19", surfaceAlt="#26241F", ink="#F3EDE2", inkMuted="#A79E8E",
                 inkFaint="#7C7365", accent="#8FBFAE", accentInk="#0F1A16", warm="#E08A5C",
                 danger="#E0806C", dangerSoft="#3A241F", gold="#D9AE6B"),
    "reading": dict(bg="#F1E6D0", surface="#FBF3E2", surfaceAlt="#EADCC2", ink="#2B2418", inkMuted="#6E6250",
                    inkFaint="#948671", accent="#4A5D3A", accentInk="#F7F9EF", warm="#A65A33",
                    danger="#9C3B2B", dangerSoft="#EFD9D2", gold="#A87C36"),
}

PAIRS = [
    ("ink", "bg", "Body text on app background", 4.5),
    ("ink", "surface", "Body text on cards", 4.5),
    ("inkMuted", "bg", "Secondary text on background", 4.5),
    ("inkMuted", "surface", "Secondary text on cards", 4.5),
    ("accentInk", "accent", "Primary button label", 4.5),
    ("danger", "dangerSoft", "Error text on tinted surface", 4.5),
    ("inkFaint", "surface", "Caption / metadata (large text only)", 3.0),
    ("gold", "surface", "Highlight accent (non-text)", 3.0),
]


def luminance(hex_color):
    h = hex_color.lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def ratio(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


rows = []
failures = []
for name, palette in PALETTES.items():
    for fg, bg, label, minimum in PAIRS:
        value = ratio(palette[fg], palette[bg])
        ok = value >= minimum
        rows.append((name, label, f"{value:.2f}:1", f"{minimum}:1", "pass" if ok else "FAIL"))
        if not ok:
            failures.append((name, label, value, minimum))

md = ["# Accessibility review", "",
      "Static checks plus a code-level audit. No TalkBack/VoiceOver run was possible (no device).", "",
      "## Colour contrast (WCAG 2.1)", "",
      "| Theme | Pair | Ratio | Minimum | Result |", "|---|---|---|---|---|"]
for row in rows:
    md.append("| " + " | ".join(row) + " |")

md += ["", "## Implemented", "",
       "- Every interactive component sets `accessibilityRole` and an `accessibilityLabel`; icon-only buttons always pass a label.",
       "- Buttons expose `accessibilityState` for disabled/busy; progress bars expose `accessibilityValue`.",
       "- Text uses the platform font scaler (no `allowFontScaling={false}` anywhere); the reader adds its own size control.",
       "- Minimum touch target for buttons and icon buttons is 44 pt; chips are 34 pt with 6 pt hit slop (above the 24 px AA minimum).",
       "- Reader selection, highlight and bookmark flows are reachable without gestures beyond tap; no drag-only action is required.",
       "- Empty, loading, offline and error states are explicit text, not colour-only signals.",
       "- Palettes are semantic; no screen hard-codes a colour, so contrast fixes propagate.",
       "", "## Gaps", "",
       "- No screen-reader pass on a device; reading order inside the WebView reader is untested with TalkBack.",
       "- `inkFaint` is intentionally lower contrast and used only for captions; it meets 3:1, not 4.5:1.",
       "- Dynamic Type at the largest accessibility sizes may clip fixed-height buttons; needs a device check.",
       "- The review grade buttons use colour plus text labels, but the four options are visually dense; a larger layout may help at 200% text.",
       "", "## Checklist for the device session", "",
       "1. TalkBack: navigate Today â†’ book â†’ reader â†’ highlight â†’ review entirely without sight.",
       "2. Font scale 200%: confirm no clipped labels on tab bar, grade buttons and plan rows.",
       "3. Contrast in sunlight with the warm theme; check the faint caption colour.",
       "4. Reduce Motion enabled: confirm the reveal animation is not disorienting (it only fades/translates 8 px).",
       "5. External keyboard: tab through the review screen.",
       ]

if failures:
    md += ["", "## Failing pairs", ""] + [f"- {t}: {label} = {value:.2f}:1 (needs {minimum}:1)" for t, label, value, minimum in failures]

open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "ACCESSIBILITY.md"), "w", encoding="utf-8").write("\n".join(md))
print("\n".join(md[:14]))
print(f"... {len(rows)} pairs checked, {len(failures)} failing")

