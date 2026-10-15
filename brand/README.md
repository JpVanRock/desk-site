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
