# Atari ST bitmap font

`atari-st.woff2` / `atari-st.ttf` — the Atari ST high-resolution **8×16 system
font**, used by the demo for authentic, pixel-crisp text.

- **Source:** [`ntwk/atarist-font`](https://github.com/ntwk/atarist-font)
  (`atarist-normal.bdf`), itself from <http://www.modelb.bbcmicro.com/retro-fonts.html>.
- **Licence:** BSD-3-Clause, © 2015 ntwk — see `atari-st-LICENSE.txt` (retained
  as required for binary redistribution).
- **Conversion:** `bdf2ttf.py` turns each lit pixel of the BDF into a filled
  square outline, so the glyphs sit exactly on the integer grid. Rebuild with
  `python3 bdf2ttf.py` (needs `fonttools` + `brotli`; edit the `SRC` path to the
  `.bdf`).

Because it's a bitmap face, it's pixel-crisp only at **integer multiples of its
native 16px** — the demo's type scale is 16px (body) / 32px (display).

# VT323 & Silkscreen (accent fonts)

`vt323-400.woff2`, `silkscreen-400.woff2`, `silkscreen-700.woff2` — self-hosted
latin subsets of the Google Fonts releases, so the app (and the plugin/extension
WebViews) needs no network access.

- **VT323** — © Peter Hull, [SIL Open Font License 1.1](https://fonts.google.com/specimen/VT323/license).
- **Silkscreen** — © Jason Kottke, [SIL Open Font License 1.1](https://fonts.google.com/specimen/Silkscreen/license).
- **Source:** downloaded from `fonts.gstatic.com` (the latin `unicode-range`
  subsets served by `fonts.googleapis.com/css2?family=VT323&family=Silkscreen:wght@400;700`).
