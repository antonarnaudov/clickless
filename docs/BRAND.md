# Clickless brand

**The AI-native open-source browser for everybody.** Launch line: *Say it. It's done.*

## The mark
The agent cursor with three rings radiating from its tip: the moment an AI clicks for you, the signal people already know from AI-driven browsers. The same three rings appear on the page whenever the Clickless agent clicks.
- App icon: Mint→Teal rings and a Cream cursor on the Deep tile (`assets/icon.png`, `icon.icns`, `icon.svg`).
- Mark alone (`assets/mark.svg`): Mint→Teal rings, Deep cursor; the gap around the cursor is transparent, so it sits on any background.
- Rings fade outward (100% → 62% → 30%) and thin out (5.5 → 4.5 → 3.5).
- Logo: mark + lowercase **clickless**, SF Pro Display Semibold, tracking −5% (`assets/logo-light.png` on light, `assets/logo-dark.png` on dark).
- Regenerate with `python3 scripts/make-brand.py`. Don't recolour, outline, rotate or add effects to the mark.

## Colour: brand and interface are separate
The brand colours belong to the logo and to the moments where the AI is working. Everything you press is quiet and monochrome, like Apple's and Linear's interfaces, so pages stay the hero.

**Brand (logo and agent moments only)**

| Name | Hex | Use |
|---|---|---|
| Mint | `#3CF0B4` | Logo ring, the agent's glow, the highlight ring on what it's about to click, live dots |
| Teal | `#10A592` | Second stop of every brand gradient |
| Deep | `#06201C` | Icon tile, logo text on light, the agent's cursor and label |
| Cream | `#F4F7F2` | Logo text on dark, the cursor in the app icon |

**Interface**

| Token | Light | Dark | Use |
|---|---|---|---|
| Ink / `--accent` | `#0F1F1B` | `#EEF3EF` | Primary buttons, toggles, focus, selection, links |
| Sage (default space) | `#5F7F75` | | Tints the chrome very lightly; spaces never colour buttons |
| `--magic` | Teal `#10A592` | | With Mint (`--warm`): gradients for agent activity only |

Rules: never use Mint or Teal for a button, chip or link. One brand moment per screen. Other spaces may pick any colour; it tints their chrome in proportion to its saturation.

## Names
Display **Clickless** · code and command line `clickless` · types `Clickless`, `ClicklessAPI`. Never abbreviate.

## Voice
Plain and confident. Say what it did for the person ("It filled the form and booked the table"), not how ("the agent dispatched 12 CDP events").
