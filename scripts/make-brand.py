"""Clickless brand assets (palette and rules: docs/BRAND.md).

Writes into assets/:
  icon.svg / icon.png (1024) / icon.icns   app icon: the ripple mark (Mint rings, Cream cursor) on the Deep tile
  mark.svg                                  the mark alone, for light backgrounds
  logo-light.png / logo-dark.png            mark + "clickless" wordmark, for light and dark backgrounds

Uses Electron to rasterise (scripts/render-html.cjs) and macOS sips/iconutil.
    python3 scripts/make-brand.py
"""
import pathlib, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"
ELECTRON = ROOT / "node_modules" / ".bin" / "electron"
RENDER = ROOT / "scripts" / "render-html.cjs"

MINT, TEAL, DEEP, CREAM = "#3CF0B4", "#10A592", "#06201C", "#F4F7F2"
# The ripple mark: the agent cursor with three rings radiating from its tip (the click point),
# fading outward, the signal people know from AI-driven browsers. The group is optically centred.
TX, TY = 56, 50
CURSOR = "M" + " L".join(f"{TX+x} {TY+y}" for x, y in [(0, 0), (0, 42), (10.5, 32.5), (18, 48), (26, 44.5), (18.5, 29), (33, 29)]) + " Z"
RINGS = [(13, 5.5, 1.0), (25, 4.5, 0.62), (37, 3.5, 0.3)]  # radius, stroke width, opacity


def mark_body(idp, cursor_fill, on_light=False):
    """Mint→Teal rings with a transparent gap around the cursor, then the cursor.
    On light backgrounds the rings are a touch deeper and stronger so the outer ones still read."""
    stops = ("#2FE0A6", "#1BC79A", "#0E8F7E") if on_light else ("#7DFBD5", MINT, TEAL)
    fade = (1.0, 0.72, 0.45) if on_light else tuple(o for _, _, o in RINGS)
    rings = "".join(f'<circle cx="{TX}" cy="{TY}" r="{r}" fill="none" stroke="url(#mint{idp})" stroke-width="{w}" stroke-opacity="{fade[k]}"/>' for k, (r, w, _) in enumerate(RINGS))
    return f'''<defs>
  <linearGradient id="mint{idp}" gradientUnits="userSpaceOnUse" x1="{TX-40}" y1="{TY-40}" x2="{TX+40}" y2="{TY+40}"><stop offset="0" stop-color="{stops[0]}"/><stop offset="0.5" stop-color="{stops[1]}"/><stop offset="1" stop-color="{stops[2]}"/></linearGradient>
  <mask id="gap{idp}" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120"><rect width="120" height="120" fill="#fff"/><path d="{CURSOR}" fill="#000" stroke="#000" stroke-width="13" stroke-linejoin="round"/></mask>
</defs>
<g mask="url(#gap{idp})">{rings}</g>
<path d="{CURSOR}" fill="{cursor_fill}" stroke="{cursor_fill}" stroke-width="4.5" stroke-linejoin="round"/>'''


def icon_svg(size=120):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 120 120">
<defs>
  <linearGradient id="tile" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="#0E352E"/><stop offset="1" stop-color="#041411"/></linearGradient>
  <radialGradient id="aura" cx="0.46" cy="0.5" r="0.5"><stop offset="0" stop-color="{MINT}" stop-opacity="0.16"/><stop offset="1" stop-color="{MINT}" stop-opacity="0"/></radialGradient>
  <radialGradient id="sheen" cx="0.28" cy="0.08" r="0.7"><stop offset="0" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect x="4" y="4" width="112" height="112" rx="27" fill="url(#tile)"/>
<rect x="4" y="4" width="112" height="112" rx="27" fill="url(#aura)"/>
<rect x="4" y="4" width="112" height="112" rx="27" fill="url(#sheen)"/>
<rect x="4.75" y="4.75" width="110.5" height="110.5" rx="26.3" fill="none" stroke="{MINT}" stroke-opacity="0.16" stroke-width="1.5"/>
{mark_body("i", CREAM)}
</svg>
'''


def mark_svg(size=120, cursor_fill=DEEP, on_light=True):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="14 8 98 98">
{mark_body("m", cursor_fill, on_light)}
</svg>
'''


def lockup_html(dark):
    ink = CREAM if dark else DEEP
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;background:transparent}} .l{{display:flex;align-items:center;gap:22px;height:300px;padding:0 40px}}
.l span{{font:650 150px/1 system-ui,-apple-system,'SF Pro Display',sans-serif;letter-spacing:-0.05em;color:{ink};transform:translateY(-8px)}}
</style></head><body><div class="l">{mark_svg(190, CREAM if dark else DEEP, not dark)}<span>clickless</span></div></body></html>'''


def render(html, out, w, h):
    with tempfile.TemporaryDirectory() as tmp:
        f = pathlib.Path(tmp) / "page.html"
        f.write_text(html)
        subprocess.run([str(ELECTRON), str(RENDER), str(f), str(out), str(w), str(h), "1"], check=True, capture_output=True)


def main():
    OUT.mkdir(exist_ok=True)
    (OUT / "icon.svg").write_text(icon_svg())
    (OUT / "mark.svg").write_text(mark_svg())
    render(f'<html><body style="margin:0;background:transparent">{icon_svg(1024)}</body></html>', OUT / "icon.png", 1024, 1024)
    render(lockup_html(False), OUT / "logo-light.png", 1000, 300)
    render(lockup_html(True), OUT / "logo-dark.png", 1000, 300)
    with tempfile.TemporaryDirectory() as tmp:
        iconset = pathlib.Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for s in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = s * scale
                name = f"icon_{s}x{s}{'@2x' if scale == 2 else ''}.png"
                subprocess.run(["sips", "-z", str(px), str(px), str(OUT / "icon.png"), "--out", str(iconset / name)], check=True, capture_output=True)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")], check=True)
    print("wrote", ", ".join(p.name for p in sorted(OUT.iterdir())))


if __name__ == "__main__":
    main()
