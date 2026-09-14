# Looks

A local-first visual archive browser, in the spirit of a desktop collections
app: collections down the left, a masonry wall of saved elements on the
right, keyboard shortcuts along the bottom.

Built with **Next.js (App Router) + React 19 + TypeScript** and rendered
almost entirely on **`<canvas>`**:

- **Masonry grid** – the element wall is a single virtualised canvas. Cards,
  clipped media, captions, authors, hover and selection rings are all drawn
  per frame from a computed layout; a sticky canvas rides inside a spacer so
  native scrolling (trackpad momentum included) keeps working.
- **Graph view** – a force-directed graph of the same elements, linked by
  author and shared tags. Pan by dragging, zoom with the wheel, drag nodes,
  hover for a tooltip.
- **Sidebar thumbnail strips** – one canvas per collection row.
- **Procedural media** – there are no image assets. Every element's "media"
  is generated deterministically from its seed into an offscreen canvas
  (photos, UI screenshots, ASCII fields, scanned documents, constellations,
  pixel sprites, type specimens, halftone prints, ridge maps…). Generation is
  queued and time-boxed so scrolling through hundreds of never-seen cards
  stays smooth.

## Run it

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

`npm run build && npm start` for a production build; `npm run lint` and
`npm run typecheck` for the checks.

## Shortcuts

| Keys | Action |
| --- | --- |
| `⌃S` | Hide / show the sidebar |
| `⇧⌘N` | New collection |
| `⌥⇧ ↑ ↓` | Switch collection |
| `↑ ↓ ← →` | Navigate elements |
| `Enter` / `Space` | Open the selected element |
| `⌘F` | Find elements in the current collection |
| `⌘,` | Settings (card width, gap, sort, captions, authors, corners) |
| `G` | Toggle Grid / Graph view |
| `Esc` | Close overlays / clear selection |

`⌘` also works as `Ctrl` on Linux and Windows. Every hint in the status bar
is clickable as well.

## Layout of the code

```
src/
  app/            Next.js root layout, page, global styles
  components/
    App.tsx       state, keyboard shortcuts, wiring
    GridCanvas    canvas masonry grid (virtualised, hover, selection, nav)
    GraphCanvas   canvas force-directed graph (pan/zoom/drag)
    Sidebar*      collection list + per-row canvas thumbnail strips
    TopBar, StatsBar, StatusBar, Lightbox, SettingsPanel
  lib/
    data.ts       deterministic archive: collections, elements, stats
    art.ts        thumbnail cache + generation queue
    artStyles.ts  the procedural renderers, one per visual family
    layout.ts     masonry layout, text wrapping, hit testing, navigation
    noise.ts      seeded value noise / fBm
    random.ts     seeded PRNG helpers
    settings.ts   settings store (localStorage) exposed as a hook
```
