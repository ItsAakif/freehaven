# Accessibility review

Static checks plus a code-level audit. No TalkBack/VoiceOver run was possible (no device).

## Colour contrast (WCAG 2.1)

| Theme | Pair | Ratio | Minimum | Result |
|---|---|---|---|---|
| light | Body text on app background | 15.72:1 | 4.5:1 | pass |
| light | Body text on cards | 17.41:1 | 4.5:1 | pass |
| light | Secondary text on background | 5.27:1 | 4.5:1 | pass |
| light | Secondary text on cards | 5.83:1 | 4.5:1 | pass |
| light | Primary button label | 7.13:1 | 4.5:1 | pass |
| light | Error text on tinted surface | 5.03:1 | 4.5:1 | pass |
| light | Caption / metadata (large text only) | 3.09:1 | 3.0:1 | pass |
| light | Highlight accent (non-text) | 3.58:1 | 3.0:1 | pass |
| dark | Body text on app background | 16.20:1 | 4.5:1 | pass |
| dark | Body text on cards | 14.62:1 | 4.5:1 | pass |
| dark | Secondary text on background | 7.12:1 | 4.5:1 | pass |
| dark | Secondary text on cards | 6.43:1 | 4.5:1 | pass |
| dark | Primary button label | 8.67:1 | 4.5:1 | pass |
| dark | Error text on tinted surface | 5.15:1 | 4.5:1 | pass |
| dark | Caption / metadata (large text only) | 3.65:1 | 3.0:1 | pass |
| dark | Highlight accent (non-text) | 8.29:1 | 3.0:1 | pass |
| reading | Body text on app background | 12.40:1 | 4.5:1 | pass |
| reading | Body text on cards | 13.90:1 | 4.5:1 | pass |
| reading | Secondary text on background | 4.81:1 | 4.5:1 | pass |
| reading | Secondary text on cards | 5.39:1 | 4.5:1 | pass |
| reading | Primary button label | 6.77:1 | 4.5:1 | pass |
| reading | Error text on tinted surface | 5.05:1 | 4.5:1 | pass |
| reading | Caption / metadata (large text only) | 3.22:1 | 3.0:1 | pass |
| reading | Highlight accent (non-text) | 3.40:1 | 3.0:1 | pass |

## Implemented

- Every interactive component sets `accessibilityRole` and an `accessibilityLabel`; icon-only buttons always pass a label.
- Buttons expose `accessibilityState` for disabled/busy; progress bars expose `accessibilityValue`.
- Text uses the platform font scaler (no `allowFontScaling={false}` anywhere); the reader adds its own size control.
- Minimum touch target for buttons and icon buttons is 44 pt; chips are 34 pt with 6 pt hit slop (above the 24 px AA minimum).
- Reader selection, highlight and bookmark flows are reachable without gestures beyond tap; no drag-only action is required.
- Empty, loading, offline and error states are explicit text, not colour-only signals.
- Palettes are semantic; no screen hard-codes a colour, so contrast fixes propagate.

## Gaps

- No screen-reader pass on a device; reading order inside the WebView reader is untested with TalkBack.
- `inkFaint` is intentionally lower contrast and used only for captions; it meets 3:1, not 4.5:1.
- Dynamic Type at the largest accessibility sizes may clip fixed-height buttons; needs a device check.
- The review grade buttons use colour plus text labels, but the four options are visually dense; a larger layout may help at 200% text.

## Checklist for the device session

1. TalkBack: navigate Today → book → reader → highlight → review entirely without sight.
2. Font scale 200%: confirm no clipped labels on tab bar, grade buttons and plan rows.
3. Contrast in sunlight with the warm theme; check the faint caption colour.
4. Reduce Motion enabled: confirm the reveal animation is not disorienting (it only fades/translates 8 px).
5. External keyboard: tab through the review screen.