---
name: store-screenshots
description: Designs and renders App Store and Google Play screenshot sets (every locale, phone and tablet) that look premium and pass both stores' rules, exported in the folder layout store-studio uploads. Use when the user wants new store screenshots, marketing frames, localized captions, device mockups, a feature graphic, or wants to fix screenshots a store rejected.
---

# Store screenshots

The goal is a set that sells the app in the first two frames and that both
stores accept on the first upload. Build it as code (one HTML page rendered
per locale, device and frame) so every language and size comes from the same
source.

## 1. Plan the story

- 5 to 8 frames. Search results show the first 2 or 3, so they carry the main
  promise; the rest cover one feature each.
- One idea per frame: a short headline (about 2 to 6 words), an optional
  one-line subline, and the app screen that proves it.
- Frames sit side by side on the product page. A shared background, a line or
  shape that runs across frame edges, or an element split between two frames
  makes the set read as one piece.
- Only claim what is true and shown in the app: no invented numbers, awards,
  rankings or reviews.

## 2. Sizes to render

| Store | Device | Size (portrait) | Output folder |
| - | - | - | - |
| App Store | iPhone 6.9" (required unless 6.5" is given) | 1320x2868 or 1290x2796 | `ios/<locale>/iphone-6.9/` |
| App Store | iPhone 6.5" (alternative) | 1284x2778 or 1242x2688 | `ios/<locale>/iphone-6.5/` |
| App Store | iPad 13" (required if the app runs on iPad) | 2064x2752 or 2048x2732 | `ios/<locale>/ipad-13/` |
| Google Play | Phone | 1080x1920 (9:16) | `play/<language>/phone/` |
| Google Play | 10" tablet | 1440x2560 (9:16) | `play/<language>/tablet/` |
| Google Play | 7" tablet (optional) | 1080x1920 or larger, 9:16 | `play/<language>/tablet-7/` |
| Google Play | Feature graphic | exactly 1024x500 | `play/<language>/feature-graphic/` |

Two traps:

- Play rejects any image whose long side is more than twice the short side.
  Phone-shaped sizes like 1080x2400 fail; 1080x1920 passes.
- One App Store folder per display type. 1284x2778 and 1242x2688 are both 6.5",
  so render only one of them.

Name files `01_name.png`, `02_name.png`, and so on: file-name order becomes store order.

## 3. Build the page

- One HTML page that reads `?lang=&device=&frame=` and lays out that frame at
  the exact pixel size. Keep copy in a per-locale table and mark accent words in
  the copy rather than in the layout code.
- Scale layout from the frame's width and height, not fixed pixels, so phone,
  tablet and landscape sizes reuse it.
- Fit headlines per language: German, Russian and French run 30 to 40% longer
  than English. Shrink the font until each line fits, and never let the browser
  wrap a headline on its own.
- Real app screens beat mockups. Capture them per locale when the app is
  localized. If the UI exists in one language only, keep the captions
  localized and don't imply otherwise.

## 4. Device frames

- Use frames you have the right to use, for example Apple's official product
  bezels under their license. For Android, a clean, unbranded drawn frame is
  safest.
- Clip the app screenshot to the frame's screen corner radius. Frame images put
  the screen rectangle behind rounded glass, and its square corners poke out
  past the body if not clipped. Measure the radius from the frame image.
- Simulator and emulator captures can have transparent corners. Flatten them
  onto the app's background color before placing them.
- Zoom into all four corners of every device in the final images before calling
  the set done.

## 5. Fonts

- Use fonts with full coverage for every locale: for example Noto Sans JP/SC/TC/KR
  for CJK, and a Cyrillic-capable face for Russian and Ukrainian.
- Web fonts load lazily, in unicode-range slices. Before capturing, load every
  face for the exact text on the page (`document.fonts.load(font, text)` for each
  face) and wait for `document.fonts.ready`. Otherwise CJK headlines can render
  invisible or in a fallback font.

## 6. Render

Headless Chrome, one call per image, with the viewport set to the exact output size:

```bash
"$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1320,2868 --virtual-time-budget=8000 \
  --screenshot=export/ios/en-US/iphone-6.9/01_hero.png \
  "file://$PWD/screens.html?lang=en-US&device=iphone&frame=1"
```

Playwright or Puppeteer work too. Set `deviceScaleFactor: 1`, `viewport` to the
exact size, and wait for fonts before `screenshot()`.

Chrome writes RGBA PNGs, and both stores reject alpha channels, so strip it:

```bash
magick in.png -background '#000' -alpha remove -alpha off out.png   # ImageMagick
ffmpeg -y -i in.png -pix_fmt rgb24 out.png                         # ffmpeg
python3 -c "from PIL import Image; Image.open('in.png').convert('RGB').save('out.png')"
```

For a big matrix (many locales, sizes and frames), keep one browser open and
drive it through Playwright, Puppeteer or the DevTools protocol instead of
starting Chrome per image.

## 7. Check before upload

- Run `screenshots_validate` for `app_store` on `export/ios` and for
  `google_play` on `export/play`. Fix every error.
- Look at a contact sheet of each locale: text fits, nothing is cut off, no
  placeholder or "sample data" labels, and no personal data such as real
  emails or names.
- Then follow the store-publish skill to upload.
