import { chance, hashString, int, mulberry32, pick, range, shuffle, type Rng } from "./random";

/** Visual family used by the procedural thumbnail renderer (see art.ts). */
export type ArtStyle =
  | "photo"
  | "ui"
  | "ascii"
  | "document"
  | "dots"
  | "pixel"
  | "grid"
  | "halftone"
  | "type"
  | "terrain";

export type ElementKind = "image" | "video" | "text";

export interface LooksElement {
  id: string;
  index: number;
  kind: ElementKind;
  style: ArtStyle;
  seed: number;
  /** height / width of the media. */
  aspect: number;
  caption: string;
  author: string;
  tags: string[];
  /** Fake on-disk footprint, bytes. */
  bytes: number;
  /** Number of media files backing this element (each also has a .md note). */
  mediaFiles: number;
  /** Collection ids this element belongs to. */
  collections: string[];
}

export interface Collection {
  id: string;
  name: string;
  elementIds: string[];
}

export interface LibraryStats {
  files: number;
  markdown: number;
  media: number;
  bytes: number;
}

export interface Library {
  collections: Collection[];
  elements: LooksElement[];
  byId: Map<string, LooksElement>;
  stats: LibraryStats;
}

export const EVERYTHING_ID = "everything";

interface CollectionSpec {
  name: string;
  count: number;
  styles: ArtStyle[];
  video?: number;
  text?: number;
}

/* Collection list mirrors the reference screenshot (names + counts). */
const COLLECTION_SPECS: CollectionSpec[] = [
  { name: "Органика", count: 10, styles: ["photo", "terrain", "halftone"] },
  { name: "Прозрачные вещи", count: 4, styles: ["photo", "halftone"] },
  { name: "Поверхности и структуры", count: 18, styles: ["photo", "terrain", "grid"] },
  { name: "Экзопланеты", count: 10, styles: ["terrain", "dots", "photo"] },
  { name: "Одежда", count: 34, styles: ["photo", "halftone"] },
  { name: "Периферия", count: 50, styles: ["photo", "ui", "pixel"] },
  { name: "Города, здания и обитатели", count: 42, styles: ["photo", "grid", "terrain"] },
  { name: "Пиксельарт и ascii", count: 18, styles: ["pixel", "ascii"] },
  {
    name: "Интерфейсы",
    count: 144,
    styles: ["ui", "ui", "document", "ascii", "dots", "grid", "photo", "type", "halftone"],
    video: 0.14,
    text: 0.06,
  },
  { name: "Эстетика прототипов", count: 15, styles: ["ui", "grid", "document"] },
  { name: "Таблицы и галереи", count: 4, styles: ["grid", "document"] },
  { name: "Нарисовано людьми", count: 21, styles: ["halftone", "photo", "dots"] },
  { name: "Ориентальное искусство", count: 9, styles: ["halftone", "type", "photo"] },
  { name: "Кибернетика", count: 20, styles: ["dots", "ascii", "terrain"] },
  { name: "Симуляция жизни", count: 10, styles: ["dots", "pixel", "ascii"], video: 0.3 },
  { name: "Анимация", count: 9, styles: ["photo", "pixel", "halftone"], video: 0.7 },
  { name: "Игры", count: 5, styles: ["pixel", "ui"], video: 0.4 },
  { name: "Аниме", count: 5, styles: ["halftone", "photo"] },
  { name: "Каталоги", count: 1, styles: ["grid"] },
  { name: "Машины", count: 5, styles: ["photo", "ui"] },
  { name: "Бумага, книги, типография", count: 1, styles: ["document", "type"] },
  { name: "Шрифты", count: 3, styles: ["type"] },
  { name: "Клавиатуры", count: 13, styles: ["photo", "grid"] },
];

const EVERYTHING_COUNT = 579;

const ALL_STYLES: ArtStyle[] = [
  "photo",
  "ui",
  "ascii",
  "document",
  "dots",
  "pixel",
  "grid",
  "halftone",
  "type",
  "terrain",
];

const CAPTIONS = [
  "Pixels breathe. A slow zoom into a dithered forest, rendered one frame per hour.",
  "Location hint globes were peak 2018 but honestly they still work as a region selector.",
  "Okay, html-in-canvas is pretty magical. Adding loupes to websites one at a time.",
  "There will be no leaps. No jumps. No wonders. Only resources, petty rivalries, and a very long list.",
  "Terminal core meets IRL: a receipt printer that prints your git log every morning.",
  "One direction from this that excites me: a learning base instead of a storage one.",
  "Generative illumination plus pretext, but make it dithered.",
  "you've seen light mode, you've seen dark mode, but have you ever seen sunny mode",
  "Using LLMs to build personal knowledge bases. Something I'm finding very useful recently.",
  "GAME CHAT SHOP. In a decrepit computer cafe you log on to the last day of a childhood MMORPG.",
  "Art on contract: an interactive tool that generates ascii art from smart contract bytecode.",
  "Auction is live. 17 hours remaining. Current bid 0.29 ETH. Yes, for a screenshot.",
  "A window manager where every window is a little paper card you can pin to the desk.",
  "Cassette futurism control panel, rebuilt as a settings page. Every toggle clicks.",
  "Notes on a monospace grid: why 11px still feels right after all these years.",
  "The best keyboards are the ones you forget about. This one I cannot forget.",
  "Marginalia as an interface pattern. Comments belong next to the thing, not below it.",
  "Recreated the 1997 file manager. It is faster than everything I use today.",
  "Dithering is compression you can see, and that is exactly why it feels honest.",
  "Sketching a graph view for the archive. Edges by author, colour by collection.",
  "A hand-drawn map of every server I have ever paid for.",
  "Someone should make a browser that only renders text and borders. Oh wait.",
  "Scanned my grandfather's technical drawings. The line weights are unreal.",
  "Halftone portraits from a thermal printer. 203 dpi and somehow perfect.",
  "Soft UI is back but this time it is made of actual glass. Refraction included.",
  "The archive is not a museum. It is a workbench.",
  "Little ridge maps of noise functions. Perlin, simplex, worley, in that order.",
  "This sliiick terminal setup with a physical scroll wheel for history.",
  "Field notes from the exoplanet catalog. Nothing habitable, everything beautiful.",
  "Cellular automaton wallpaper generator. Rule 110 never gets old.",
  "Constellation of every tab I closed this week. Lines connect shared domains.",
  "A typeface where every glyph is a tiny floor plan.",
  "Prototype aesthetic: grey boxes, blue links, no shadows, zero apologies.",
  "Photographed the same brutalist stairwell every day for a month.",
  "Tiny pixel sprites for a game that does not exist yet.",
  "If your table needs a legend it is a gallery. If your gallery needs a filter it is a table.",
  "Made a physical dial for scrubbing through commit history. Weirdly emotional.",
  "The interface is a place. Treat it like one.",
  "ASCII weather station, streaming to a 40 column display in the kitchen.",
  "Every design system eventually becomes a catalog of its own exceptions.",
  "Wireframe globe spinning in a corner of the dashboard. Serves no purpose. Stays.",
  "Paper prototypes photographed under a desk lamp beat any export.",
  "Lo-fi simulation of a coral reef. 60 agents, zero textures.",
  "Reading kanji specimen sheets like they are poetry. Which they are.",
  "Debug view turned out prettier than the actual product. Shipped the debug view.",
  "Organic shapes generated from the audio of a rainy afternoon.",
  "Overlay of 300 airline route maps. Looks like a nervous system.",
  "Transparent electronics from the nineties. You could see the future inside them.",
  "A calendar that renders each month as a heightmap of how busy you were.",
  "Retro game manual scans. The typography of instructions was a genre.",
  "My whole desk fits in 640x480 if I squint.",
  "Prototype of a spatial file browser. Files drift toward the collections they belong to.",
  "Keyboard with e-ink keycaps. The layout swaps when the app changes.",
  "Halftone moon phases printed on receipt paper. Cheap, endless, lovely.",
  "Anime background artists were doing colour grading before it had a name.",
  "The graph view finally works. Turns out I mostly save things by three people.",
  "oh woa i actually have the same idea",
  "This is sliiiick",
  "saving this for the palette alone",
  "the density here is exactly right",
  "not sure what this is but i want to live in it",
  "reference for the sidebar rework",
];

const AUTHORS = [
  "gridwalker",
  "softmachine",
  "paperlantern",
  "lo_fi_lab",
  "dither_dan",
  "quietpixels",
  "halfbyte",
  "ridgeline",
  "tinyterminal",
  "monoscape",
  "arenaut",
  "cablecore",
  "polytext",
  "nullshapes",
  "glassbrick",
  "slowrender",
  "plaintextual",
  "kernelpanic_",
  "sunnymode",
  "axisorigin",
  "neonpaper",
  "wirebound",
  "cardboardui",
  "looper_",
  "ferrofluid",
  "vectorhaus",
  "thermalprint",
  "orbitalnotes",
  "basaltdesk",
  "riso_room",
  "pixelmoss",
  "cassette_ui",
  "deskplant",
  "octaveshift",
  "tabhoarder",
  "fieldnotes_",
  "marginal_ia",
  "quietcursor",
  "nightgrid",
  "yoshi_types",
];

const STYLE_TAGS: Record<ArtStyle, string[]> = {
  photo: ["photo", "texture"],
  ui: ["ui", "software"],
  ascii: ["ascii", "terminal"],
  document: ["print", "reading"],
  dots: ["graph", "network"],
  pixel: ["pixel", "game"],
  grid: ["catalog", "system"],
  halftone: ["print", "drawing"],
  type: ["type", "print"],
  terrain: ["map", "noise"],
};

const EXTRA_TAGS = ["archive", "tool", "night", "paper", "hardware", "web", "studio", "field"];

function aspectFor(style: ArtStyle, rng: Rng): number {
  switch (style) {
    case "ui":
      return range(rng, 0.56, 0.8);
    case "document":
      return range(rng, 1.15, 1.45);
    case "type":
      return range(rng, 0.5, 0.8);
    case "photo":
      return chance(rng, 0.3) ? range(rng, 1.1, 1.4) : range(rng, 0.62, 1.0);
    case "ascii":
      return range(rng, 0.7, 1.1);
    case "dots":
      return range(rng, 0.8, 1.2);
    case "pixel":
      return range(rng, 0.75, 1.0);
    case "grid":
      return range(rng, 0.6, 1.0);
    case "halftone":
      return range(rng, 0.9, 1.4);
    case "terrain":
      return range(rng, 0.6, 1.0);
  }
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
}

function makeElement(index: number, spec: CollectionSpec | null, rng: Rng, collectionId: string | null): LooksElement {
  const id = `e${index}`;
  const style = spec ? pick(rng, spec.styles) : pick(rng, ALL_STYLES);
  const videoP = spec?.video ?? 0.08;
  const textP = spec?.text ?? 0.04;
  const roll = rng();
  const kind: ElementKind = roll < textP ? "text" : roll < textP + videoP ? "video" : "image";
  const mediaFiles = kind === "text" ? 0 : int(rng, 1, 3) + (chance(rng, 0.22) ? 1 : 0);
  const perFile = kind === "video" ? range(rng, 2e6, 9.4e6) : range(rng, 0.15e6, 1.5e6);
  const tags = shuffle(rng, [...STYLE_TAGS[style], pick(rng, EXTRA_TAGS)]).slice(0, int(rng, 1, 3));
  return {
    id,
    index,
    kind,
    style,
    seed: hashString(`${id}:${style}`),
    aspect: aspectFor(style, rng),
    caption: pick(rng, CAPTIONS),
    author: pick(rng, AUTHORS),
    tags,
    bytes: Math.round(mediaFiles * perFile + range(rng, 400, 4000)),
    mediaFiles,
    collections: collectionId ? [collectionId] : [],
  };
}

export function buildLibrary(seed = 20240917): Library {
  const rng = mulberry32(seed);
  const elements: LooksElement[] = [];
  const collections: Collection[] = [];

  for (const spec of COLLECTION_SPECS) {
    const id = slug(spec.name);
    const ids: string[] = [];
    for (let i = 0; i < spec.count; i++) {
      const el = makeElement(elements.length, spec, rng, id);
      elements.push(el);
      ids.push(el.id);
    }
    collections.push({ id, name: spec.name, elementIds: ids });
  }

  while (elements.length < EVERYTHING_COUNT) {
    elements.push(makeElement(elements.length, null, rng, null));
  }

  // A few elements live in more than one collection, like a real archive.
  // Membership is swapped rather than added so every collection keeps its
  // exact count: the guest takes the place of the host's last own element,
  // which drops back to "Everything" only.
  const byIdTmp = new Map(elements.map((e) => [e.id, e]));
  for (const el of elements) {
    if (el.collections.length !== 1 || !chance(rng, 0.06)) continue;
    const host = pick(rng, collections);
    if (host.elementIds.length < 4 || el.collections.includes(host.id)) continue;
    const evicted = [...host.elementIds]
      .reverse()
      .map((id) => byIdTmp.get(id)!)
      .find((e) => e.collections.length === 1 && e.collections[0] === host.id && e !== el);
    if (!evicted) continue;
    host.elementIds.splice(host.elementIds.indexOf(evicted.id), 1);
    evicted.collections = [];
    host.elementIds.push(el.id);
    el.collections.push(host.id);
  }

  // "Everything" is newest-first over the whole archive.
  const everything: Collection = {
    id: EVERYTHING_ID,
    name: "Everything",
    elementIds: shuffle(rng, elements.map((e) => e.id)),
  };

  const byId = new Map(elements.map((e) => [e.id, e]));

  const media = elements.reduce((n, e) => n + e.mediaFiles, 0);
  // Every element has a note, every collection (Everything included) has an
  // index note, plus a handful of top-level notes (readme, changelog, ...).
  const LIBRARY_NOTES = 7;
  const markdown = elements.length + collections.length + 1 + LIBRARY_NOTES;
  const bytes = elements.reduce((n, e) => n + e.bytes, 0);
  const stats: LibraryStats = { files: media + markdown, markdown, media, bytes };

  return { collections: [everything, ...collections], elements, byId, stats };
}

/** Module-level singleton so the server and client render the same archive. */
export const LIBRARY: Library = buildLibrary();

export function elementsOf(library: Library, collection: Collection): LooksElement[] {
  const out: LooksElement[] = [];
  for (const id of collection.elementIds) {
    const el = library.byId.get(id);
    if (el) out.push(el);
  }
  return out;
}
