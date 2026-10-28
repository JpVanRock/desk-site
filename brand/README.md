# Brand assets

The Sisyphus mark: the figure inside a golden-ratio construction, redrawn as brush strokes.

## Which file to use

| File | Ink | Use on |
| --- | --- | --- |
| `sisyphus-mark.svg` | `currentColor` | **Preferred.** One file, both themes. Inherits the CSS `color` of its parent. |
| `sisyphus-mark-on-light.svg` | `#111111` | A white / light background |
| `sisyphus-mark-on-dark.svg` | `#F0EFEC` | A black / dark background |
| `sisyphus-mark-bold.svg` | `currentColor` | A heavier cut, for small sizes or where more presence is wanted |

The ink on dark is an off-white (`#F0EFEC`), not pure white. Pure white on a near-black
background glares and makes the thin frame strokes vibrate. Change it only deliberately.

## Preferred usage: one file, both themes

`sisyphus-mark.svg` fills with `currentColor`, so the theme controls it and there is no
risk of shipping the wrong variant:

```css
.logo { color: #111111; }                 /* light theme */
[data-theme="dark"] .logo { color: #F0EFEC; }  /* dark theme */
```

```html
<span class="logo"><!-- inline the SVG here --></span>
```

Inline the SVG (or import it as a React component) rather than using `<img src>`:
an `<img>` cannot inherit `color`, and the two fixed-ink files exist for that case.

## Geometry

- viewBox `0 0 870 1370`, aspect ratio about 0.635 : 1 (portrait)
- The artwork sits inside the viewBox with an even margin; no extra padding needed
- 37 paths, a single `<g>`, `fill-rule="evenodd"`
- No strokes — every mark is a filled outline, so it scales without stroke-width issues

## Sizing

Legible down to about 48 px tall. Below that the figure closes up and only the frame and
circle read, so do not use it as a favicon at 16 or 32 px. If a favicon is needed, a
separate simplified mark should be drawn rather than scaling this one down.

## Suggested surfaces

These are the values used in the preview, not a fixed brand palette:

- light surface `#FCFCFB`, ink `#111111`
- dark surface `#1A1A19`, ink `#F0EFEC`

## Provenance

Derived from a 93x137 px scan supplied by the owner: cleaned, reduced to centrelines, and
re-rendered as variable-width brush strokes. The source resolution is the reason the mark
does not hold below ~48 px. If the original drawing exists at higher resolution, or the
artwork is redrawn, the mark can be rebuilt sharper.

**Rights:** the provenance of the underlying drawing has not been confirmed. Settle that
before the mark goes on client-facing material.


## Raster mark, 2026-10-28

The owner supplied the artwork at 1024x1024 with a red FOAO seal, which is the higher-resolution
original this README anticipated. It replaced the inline SVG symbol on the site.

| File | Ink | Background | Use on |
| --- | --- | --- | --- |
| `assets/foao-mark-on-dark.png` (+ `@2x`) | `#F0EFEC`, seal `#D6524A` | transparent | dark theme |
| `assets/foao-mark-on-light.png` (+ `@2x`) | `#111111`, seal `#9C2D2A` | transparent | light theme |
| `assets/foao-mark-black-bg.png` | `#F0EFEC`, seal `#D6524A` | solid `#1A1A19` | sharing, print, anywhere a tile is wanted |
| `brand/foao-mark-source-1024.png` | as supplied | as supplied | the source of record |

**Why raster, and why not traced.** The drawing is brushwork with a coloured seal in it. No
vectoriser was available, and a single-colour trace would have discarded both the seal and the
brush texture. The site therefore themes by swapping the file rather than by `currentColor`,
which is the fixed-ink case this README already describes.

**Why transparent on the site.** Neither site surface matches the brand surfaces above: the page
is `#0e1116` dark and `#f5f6f8` light, both cool-toned, against a warm `#1A1A19` and `#FCFCFB`. A
baked background would show as a visible rectangle in the header.

**The seal is treated separately from the ink.** A plain inversion turns the red seal cyan. The
dark variant lifts the seal from `#9C2D2A` to `#D6524A` so it still reads as the same red against
near-black, and inverts only the greys.

**The figure reads as a negative on dark.** Inverting a hatched line drawing turns a lit form with
dark hatching into a dark form with light hatching. That is inherent to the inversion, not a
defect; redraw the dark variant by hand if a lit figure is wanted there.

The old `sisyphus-mark.svg` stays as the record of the previous mark and is no longer inlined.
