import type {
  AnnotationBundle,
  BoundElement,
  ElementRef,
  InkCapture,
  Point,
  Rect,
  ReferenceableKind,
  ReferenceAnnotation,
} from "./annotation.js";
import { formatTimecode } from "./annotation.js";
import { REQUEST_SECTIONS, renderWhatToDo, requestHeader } from "./requestFormat.js";
import { renderElementTarget } from "./elementRequest.js";

export type { ReferenceAnnotation } from "./annotation.js";
export { isReferenceAnnotation } from "./annotation.js";

/** Percentage formatting for positions inside prompts (one decimal place). */
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function describeRect(rect: Rect): string {
  return `x ${pct(rect.x)}–${pct(rect.x + rect.width)}, y ${pct(rect.y)}–${pct(rect.y + rect.height)} (w ${pct(rect.width)}, h ${pct(rect.height)})`;
}

function describePoint(point: Point): string {
  return `(${pct(point.x)}, ${pct(point.y)})`;
}

function describeElement(element: ElementRef | undefined): string | null {
  if (!element) return null;
  const parts: string[] = [];
  if (element.tagName) parts.push(`<${element.tagName.toLowerCase()}>`);
  if (element.hfId) parts.push(`hf-id="${element.hfId}"`);
  if (element.id) parts.push(`id="${element.id}"`);
  if (element.selector) {
    const idx = element.selectorIndex ? ` [${element.selectorIndex}]` : "";
    parts.push(`selector \`${element.selector}\`${idx}`);
  }
  if (element.text) {
    const trimmed = element.text.replace(/\s+/g, " ").trim();
    const clipped = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    if (clipped) parts.push(`text "${clipped}"`);
  }
  if (element.box) parts.push(`box ${describeRect(element.box)}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Shape kind as a sentence, used inside the body lines. */
function describeShapeKind(annotation: ReferenceAnnotation): string {
  switch (annotation.shape.kind) {
    case "region":
      return "Region";
    case "arrow":
      return "Arrow move";
  }
}

/**
 * What the block says about its shape.
 *
 * ## Coordinates only where they carry the meaning
 *
 * An arrow's whole content **is** a displacement: "from here to there". Without the two
 * points there is nothing to act on, so it states them.
 *
 * A region does not work that way. Its rectangle is a *gesture* — the fact that a human drew
 * a circle around something — and what the reader needs is the thing inside, which the
 * attached picture shows exactly. Printing `x 32.1%–58.4%, y 41.2%–63.9%` gave the reader a
 * measurement to re-apply and no idea what was in it; the user's words were: "你要是光告诉个
 * 坐标，那肯定我始终两者都要…他也不知道圈了哪些内容呀"(found.md F-099).
 *
 * So a region is described by its picture, and by coordinates **only when no picture exists**
 * (an old payload, or a capture that failed) — otherwise there would be nothing at all.
 */
function describeShapeBody(annotation: ReferenceAnnotation, hasPicture: boolean): string[] {
  const lines: string[] = [];
  const { shape } = annotation;
  switch (shape.kind) {
    case "region":
      lines.push(`- Kind: ${describeShapeKind(annotation)} (a rectangular area, not bound to an element)`);
      if (!hasPicture) lines.push(`- Area: ${describeRect(shape.rect)}`);
      break;
    case "arrow":
      lines.push(`- Kind: ${describeShapeKind(annotation)}`);
      lines.push(`- Tail (origin) ${describePoint(shape.from)} → head (target) ${describePoint(shape.to)}`);
      lines.push("- Intent: move or adjust whatever the tail points at to the head position.");
      break;
  }
  return lines;
}

/**
 * Render one annotation as a block inside the prompt.
 *
 * The output is prose for a human (that is, an AI) reader, not JSON: structured
 * natural language is understood far better than raw coordinate arrays, and the
 * user can also read what is about to be sent.
 *
 * The heading is the annotation's **block reference** (`Region 1`, `Arrow 2`) so the
 * user's own text, the badge on the canvas and this block all name the same thing.
 */
export function renderAnnotation(annotation: ReferenceAnnotation, index: number): string {
  const { frame } = annotation;
  const lines: string[] = [];

  /*
   * The heading is the block's own reference when the sender assigned one, so a request that
   * mixes marks, elements and captures reads as one numbered sequence. The fallback keeps an
   * older payload readable: its order is its list order.
   */
  lines.push(`### ${annotation.ref ?? annotationRef(annotation.shape.kind, index)}`);

  // The three locators: file, time, size. This is the minimum sufficient
  // information for the agent to reproduce the frame.
  lines.push(`- Composition: \`${frame.compositionPath}\``);
  lines.push(`- Timecode: ${formatTimecode(frame.time)} (${frame.time.toFixed(3)}s)`);
  lines.push(`- Canvas: ${frame.compositionWidth}×${frame.compositionHeight}`);

  /*
   * The picture is the primary description. Every numbered block gets one, so a region is
   * read as "look at this" rather than as a rectangle to reconstruct.
   */
  const hasPicture =
    typeof annotation.frameImagePath === "string" && annotation.frameImagePath.trim() !== "";
  lines.push(...describeShapeBody(annotation, hasPicture));

  const element = describeElement(annotation.element);
  if (element) lines.push(`- Element: ${element}`);

  if (annotation.note.trim()) {
    lines.push(`- My note: ${annotation.note.trim()}`);
  }

  if (hasPicture) {
    lines.push(`- Frame capture: \`${annotation.frameImagePath}\``);
  }
  /*
   * A withdrawn mark is stated, not silently dropped.
   *
   * The user wrote text referring to this block and then undid the drawing. Quietly
   * removing the block would leave their sentence pointing at a heading that no
   * longer exists; leaving the block unmarked would ask an agent to change
   * something that is not on the picture. Saying it outright is the only honest
   * option, and it makes the red chip in the interface make sense.
   */
  if (annotation.withdrawn) {
    lines.push(
      "- Status: **withdrawn** — this mark was undone and is no longer on the frame; ignore it unless the request says otherwise.",
    );
  }

  return lines.join("\n");
}

/** Readable name for a referencable shape kind. Used for block references. */
export function annotationKindLabel(kind: ReferenceableKind): string {
  switch (kind) {
    case "region":
      return "Region";
    case "arrow":
      return "Arrow";
  }
}

/**
 * Block reference for an annotation, e.g. `Region 1`.
 *
 * This is the form the **interface** shows: one deletable block. Coordinates and
 * screenshot paths are machine details attached at delivery time by
 * `renderAnnotation` / `renderBundle`, never shown in the prompt box itself.
 *
 * Ink has no reference — see `isReferenceableShape` for why numbering a freehand
 * stroke would consume an ordinal and repoint sentences the user already wrote.
 */
export function annotationRef(kind: ReferenceableKind, index: number): string {
  return `${annotationKindLabel(kind)} ${index + 1}`;
}

/**
 * Block reference for a capture, e.g. `Capture 3`.
 *
 * Same shape as an annotation's reference on purpose: a capture is a block the user can name
 * and delete, not a hidden attachment. It carries no coordinates in the box because there is
 * nothing to say about it beyond "this is the frame as it looked then" — the picture is the
 * whole content.
 */
export function captureRef(index: number): string {
  return `Capture ${index + 1}`;
}

/**
 * Block reference for a whiteboard drawing, e.g. `Drawing 2`.
 *
 * A whiteboard sketch is a block like any other — the user must be able to see it will be
 * sent and delete it — but it is **not** a frame: calling it `Capture 2` would claim there
 * is a moment of the video behind it, and there is none. The board has its own pages and its
 * own time, so the block says so.
 *
 * The number still comes from the one shared position sequence, so a request reads
 * `Region 1` → `Drawing 2` → `Capture 3` with no gaps and no repeated numbers.
 */
export function drawingRef(index: number): string {
  return `Drawing ${index + 1}`;
}

/**
 * One block label, from **one shared position**.
 *
 * All four kinds draw from the same counter, so a request reads as a single numbered
 * sequence: `Element 1`, then `Capture 2`, then `Capture 3`. Per-kind numbering (each
 * starting at 1) produced `Element 1` next to `Capture 1`, which reads as though the
 * document has two first items and makes the number useless as an identifier
 * (found.md F-107).
 *
 * The `kind` still says what the block **is**; only the number is shared.
 */
export function blockRef(
  kind: "region" | "arrow" | "element" | "capture" | "drawing",
  ordinal: number,
): string {
  const label =
    kind === "region"
      ? "Region"
      : kind === "arrow"
        ? "Arrow"
        : kind === "element"
          ? "Element"
          : kind === "drawing"
            ? "Drawing"
            : "Capture";
  return `${label} ${ordinal}`;
}

/**
 * Matches any block reference, e.g. `Region 1`, `Arrow 12`, `Element 3`.
 *
 * `Element` is included because an element added from Studio's selection is a block in
 * exactly the same sense: it is a numbered target the user's sentence can name. Leaving
 * it out would mean deleting the element block from the box did not renumber the ones
 * after it.
 */
const REF_PATTERN = /(Region|Arrow|Element|Capture|Drawing) (\d+)/g;

/**
 * Renumber the block references in the prompt box after one is removed.
 *
 * Why this exists: references are **positional** — the badge on the canvas, the chip
 * and the heading in the delivered prompt all derive from a block's position. Removing
 * a block therefore shifts every later one down by one, and the text the user already
 * typed has to shift with it, or `Arrow 3` would quietly start pointing at what used to
 * be `Arrow 4`.
 *
 * `removedOrdinal` is 1-based, matching what the user sees.
 */
export function renumberAnnotationRefs(text: string, removedOrdinal: number): string {
  return text.replace(REF_PATTERN, (whole, kind: string, digits: string) => {
    const ordinal = Number.parseInt(digits, 10);
    if (!Number.isFinite(ordinal) || ordinal <= removedOrdinal) return whole;
    return `${kind} ${ordinal - 1}`;
  });
}

/**
 * Renumber every reference after one was removed, across **all** kinds.
 *
 * Because the numbers form one sequence (`Element 1`, `Capture 2`, `Capture 3`), removing a
 * block shifts everything after it by one **regardless of kind** — `renewAnnotationRefs`
 * compared numbers per kind only by accident of the old scheme. Getting this wrong left the
 * text naming numbers no block had, and the box then rendered those lines as plain text
 * instead of chips (found.md F-108).
 *
 * The kind is preserved verbatim; only the number moves.
 */
export function renumberBlockRefs(text: string, removedOrdinal: number): string {
  return text.replace(REF_PATTERN, (whole, kind: string, digits: string) => {
    const ordinal = Number.parseInt(digits, 10);
    if (!Number.isFinite(ordinal) || ordinal <= removedOrdinal) return whole;
    return `${kind} ${ordinal - 1}`;
  });
}

/** Remove every reference to one block, for when the block itself is deleted. */
export function dropAnnotationRef(text: string, ordinal: number): string {
  const kept = text
    .replace(REF_PATTERN, (whole, _kind: string, digits: string) =>
      Number.parseInt(digits, 10) === ordinal ? "" : whole,
    )
    /*
     * A block reference owns its **whole line**, so deleting one leaves an empty line behind.
     * Collapsing it is what keeps the remaining references adjacent — three empty lines
     * between `Capture 1` and `Capture 3` reads like a formatting accident, and it grows by
     * one every time a block is removed (found.md F-108).
     */
    .split("\n")
    .filter((line) => line.trim() !== "")
    // Deleting a token inside a line leaves doubled spaces and stray spaces before punctuation.
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+([,.;:!?])/g, "$1")
        .trimEnd(),
    )
    .join("\n")
    .trim();
  return kept;
}

/**
 * Append a block reference at the end of the text, on a line of its own.
 *
 * This is what pressing `S` does. Appending rather than replacing, because the user
 * writes as they draw: circle one thing, `S`, a sentence about it, circle the next,
 * `S` again. Replacing would throw away the sentence they just wrote.
 *
 * A line of its own, because a block reference is a **block** — the prompt box
 * shows it as one deletable unit, and mixing it into a sentence makes "delete the
 * whole block" ambiguous. `text.trimEnd()` keeps the result from drifting down the
 * box by one blank line on every press.
 */
export function appendAnnotationRef(text: string, ref: string): string {
  const body = text.trimEnd();
  if (!body) return ref;
  return `${body}\n${ref}`;
}

/**
 * Where each composition's timecodes are, **grouped per composition**.
 *
 * ## The defect this replaces
 *
 * The section used to collapse every timecode in the request into one range:
 *
 * ```
 * ## Timecodes covered
 *
 * 00:02.000 – 00:10.000
 * ```
 *
 * That is a true statement only when every mark is on **one** composition. As soon as a
 * request touches two — and it routinely does, because `index.html` embeds `cover.html`,
 * `balance.html`, … each with a playhead starting at 0 — the single range says something
 * false in two different ways:
 *
 * - it presents two isolated moments in different files as one continuous span;
 * - and the numbers are not even on the same axis, so the difference between them means
 *   nothing at all.
 *
 * A reader cannot detect either mistake. It would seek to a timecode that does not exist in
 * the file it opened, and the frame would not match the capture.
 *
 * ## The shape now
 *
 * ```
 * ## Where to look
 *
 * - Composition `index.html`: 00:02.162
 * - Composition `compositions/cover.html`: 00:00.500, 00:04.000
 * ```
 *
 * One line per file, each listing the exact moments named for **that** file. Sorted by path so
 * the section is stable between renders, and moments sorted and de-duplicated so it reads like
 * a list of places rather than a log of events.
 *
 * ## What is deliberately not in here
 *
 * Board sketches: they carry a time only so routing can identify the frame the board replaced.
 * Listing it would claim the request is about that moment of the video, which is exactly what a
 * sketch is not (found.md F-128).
 *
 * Elements are included — they have a frame now — but only the ones that actually state one, so
 * an older payload degrades to the annotations it does have instead of inventing a location.
 */
function whereToLookSection(bundle: AnnotationBundle): string | null {
  /** composition path → the moments named for that file. */
  const byComposition = new Map<string, number[]>();

  const add = (compositionPath: string, time: number): void => {
    if (!compositionPath.trim()) return;
    if (!Number.isFinite(time) || time < 0) return;
    const existing = byComposition.get(compositionPath);
    if (existing) existing.push(time);
    else byComposition.set(compositionPath, [time]);
  };

  for (const annotation of bundle.annotations) {
    add(annotation.frame.compositionPath, annotation.frame.time);
  }
  for (const capture of bundle.ink ?? []) {
    if (capture.board) continue;
    add(capture.compositionPath, capture.time);
  }
  /*
   * An element's frame is where the element was seen. It has to be listed, because its picture
   * is a picture of that frame: leaving it out means the reader cannot reproduce the evidence
   * it is being asked to trust.
   */
  for (const element of bundle.elements ?? []) {
    if (!element.frame) continue;
    add(element.frame.compositionPath, element.frame.time);
  }

  if (byComposition.size === 0) return null;

  const lines = [...byComposition.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([compositionPath, times]) => {
      const momentList = [...new Set(times)]
        .sort((a, b) => a - b)
        .map((time) => `${formatTimecode(time)} (${time.toFixed(3)}s)`)
        .join(", ");
      return `- Composition \`${compositionPath}\`: ${momentList}`;
    });

  return ["## Where to look", "", ...lines].join("\n");
}

/**
 * How many distinct frames carry handwriting.
 *
 * Counts frames, not capture entries: a stroke overwrites the previous picture of the
 * same frame, and reporting "2 handwritten frames" when the user drew a circle and then
 * an underline on one slide would be wrong. Board sketches are not frames and are not
 * counted here — they are reported separately in the header (found.md F-128).
 */
function inkCount(bundle: AnnotationBundle): number {
  const keys = new Set<string>();
  for (const capture of bundle.ink ?? []) {
    if (capture.board) continue;
    keys.add(`${capture.compositionPath}@${capture.time}`);
  }
  return keys.size;
}

/**
 * The handwriting line of the header, in **blocks** — the same unit as the total above it.
 *
 * ## The contradiction this removes
 *
 * The header said `Blocks: 2` and, directly beneath, `Handwritten frames: 1`. Both were true,
 * and together they read as a mistake: a reader counting two `Capture` blocks is told there is
 * one of them.
 *
 * The cause was two units in one list. `Blocks` counts **blocks**; `inkCount` counts **distinct
 * frames**, which was the right measure when one frame kept one picture. It is not right now:
 * every `Ctrl+S` adds a block, so one frame can carry several — and the count beside a total of
 * blocks has to be in blocks.
 *
 * Frames are still worth mentioning, because they say how much seeking is required, so they are
 * named separately rather than replacing the block count.
 */
function handwritingSummary(bundle: AnnotationBundle): string[] {
  const captures = (bundle.ink ?? []).filter((capture) => !capture.board).length;
  if (captures === 0) return [];
  const frames = inkCount(bundle);
  return [
    frames === captures
      ? `  - Handwriting captures: ${captures}`
      : `  - Handwriting captures: ${captures} (on ${frames} frame${frames === 1 ? "" : "s"})`,
  ];
}

/** How many whiteboard sketches the request carries. */
function boardCount(bundle: AnnotationBundle): number {
  return (bundle.ink ?? []).filter((capture) => capture.board).length;
}

/**
 * How many blocks the request carries, of every kind.
 *
 * ## Why "items" must count all of them
 *
 * The outbox filename used `annotations.length`, so a request holding `Element 1` and
 * `Capture 2` was written as `…_0items.json` — a file that says it is empty while carrying two
 * blocks. That name is what someone reads while debugging a missing delivery, and it actively
 * misleads them.
 *
 * The count is defined here, next to the rendering, so the filename and the prompt cannot
 * disagree about what "items" means.
 */
export function blockCount(bundle: AnnotationBundle): number {
  /*
   * `ink` already holds board sketches — they travel in the same list because both are "a
   * picture the user asked for". Adding `boardCount` on top would count every sketch twice.
   */
  return bundle.annotations.length + (bundle.elements ?? []).length + (bundle.ink ?? []).length;
}

/**
 * The blocks this request names, as one flat list.
 *
 * A reader's first question after the user's words is "what exactly is referred to?" — and until
 * now the answer was spread across three sections with no single place that said it. A short
 * list of the references, in request order, lets a reader resolve every name in the user's
 * sentence before reading any detail.
 */
function blockListSection(bundle: AnnotationBundle): string | null {
  const refs: string[] = [];
  if (bundle.annotations.length > 0) refs.push(...bundle.annotations.map((a) => a.ref ?? ""));
  for (const element of bundle.elements ?? []) refs.push(element.ref ?? "");
  for (const capture of bundle.ink ?? []) refs.push(capture.ref ?? "");
  const named = refs.filter((ref) => ref.trim() !== "");
  if (named.length === 0) return null;
  /*
   * Sorted by number, not by kind: the numbers are one sequence, so reading them in order is
   * what shows the reader that they are one sequence.
   */
  const ordered = named
    .map((ref) => ({ ref, ordinal: Number.parseInt(ref.split(" ").at(-1) ?? "", 10) }))
    .sort((a, b) => (Number.isFinite(a.ordinal) ? a.ordinal : 0) - (Number.isFinite(b.ordinal) ? b.ordinal : 0))
    .map((entry) => `\`${entry.ref}\``);
  return ["## Blocks in this request", "", ordered.join(", ")].join("\n");
}

/**
 * `Region 1`, `Arrow 3`, … → 1, 3, …  `null` when the reference does not end in a number.
 *
 * Ordering is done on the number because the number is the order: the reference list at the top
 * reads in numeric order, so the detail blocks must too.
 */
function ordinalOfRef(ref: string | undefined): number | null {
  if (!ref) return null;
  const digits = ref.trim().split(" ").at(-1) ?? "";
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Every block's detail, in one list, ordered by reference number.
 *
 * The three kinds are rendered by three different functions (`renderAnnotation`,
 * `renderElementTarget`, `inkSection`'s per-capture body), because what each one *is* differs.
 * What must not differ is **where the reader meets it**: a block is one block, and the request
 * order is the only order a reader can rely on.
 *
 * Pictures are no longer a separate "Handwriting" section. A `Capture 4` is a block like any
 * other — it has a number, it is in the reference list, the user can name it in a sentence — so
 * it appears in its numbered place with its own heading. Keeping it in a section *after* the
 * others meant a reader resolving "Capture 4" walked the whole document to find it.
 */
function renderBlockDetails(bundle: AnnotationBundle): string[] {
  interface Entry {
    readonly ordinal: number | null;
    readonly text: string;
  }
  const entries: Entry[] = [];

  bundle.annotations.forEach((annotation, index) => {
    entries.push({
      ordinal: ordinalOfRef(annotation.ref) ?? index + 1,
      text: renderAnnotation(annotation, index),
    });
  });

  for (const element of bundle.elements ?? []) {
    entries.push({ ordinal: ordinalOfRef(element.ref), text: renderElementBlock(element) });
  }

  const seen = new Set<string>();
  let anonymous = 0;
  for (const capture of bundle.ink ?? []) {
    const key = capture.imagePath.trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const ordinal = ordinalOfRef(capture.ref);
    /*
     * An unnamed picture still needs a distinct heading. It gets a running number purely so the
     * document is unambiguous; it is not claimed to be a block number (an older payload has no
     * place in a sequence that did not exist yet).
     */
    if (ordinal === null) anonymous += 1;
    entries.push({
      ordinal,
      text: renderCaptureBlock(capture, ordinal === null ? anonymous : null),
    });
  }

  /*
   * Sorted by number, and ties keep insertion order. A block without a number (an old payload)
   * goes last rather than first: it is the exception, and interrupting the sequence at the top
   * would make the numbering look broken.
   */
  return entries
    .sort((a, b) => {
      if (a.ordinal === null && b.ordinal === null) return 0;
      if (a.ordinal === null) return 1;
      if (b.ordinal === null) return -1;
      return a.ordinal - b.ordinal;
    })
    .map((entry) => entry.text);
}

/** One selected element, with its locators and picture. */
function renderElementBlock(element: BoundElement): string {
  const body = renderElementTarget(element.target).replace(/^### .*\n/, "");
  /*
   * Where the element was seen.
   *
   * An `Element N` block used to say only *what* it is (`<ul>`, `.lines`, a source file) and
   * never *where*, while its picture was a picture of one specific frame. In a request that
   * touches more than one composition that is unusable: the reader cannot reproduce the
   * frame, and "the current video" names neither file.
   *
   * So the block states its composition, timecode and canvas, exactly like a region does —
   * the same three locators, in the same order, so a reader learns the shape once.
   */
  const locators =
    element.frame === undefined
      ? []
      : [
          `- Composition: \`${element.frame.compositionPath}\``,
          `- Timecode: ${formatTimecode(element.frame.time)} (${element.frame.time.toFixed(3)}s)`,
          `- Canvas: ${element.frame.compositionWidth}×${element.frame.compositionHeight}`,
        ];
  /*
   * The picture, when there is one, at the same place an annotation's capture appears:
   * after the description, as corroboration, never instead of it.
   */
  const picture =
    typeof element.frameImagePath === "string" && element.frameImagePath.trim() !== ""
      ? [`- Frame capture: \`${element.frameImagePath}\``]
      : [];
  const details = [...locators, ...body.split("\n"), ...picture]
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n");
  const heading = element.ref ?? "Element";
  return `### ${heading}\n${details}`;
}

/**
 * One picture block: a frame the user drew on, or a whiteboard page.
 *
 * They share a renderer because they share a **behaviour** — each is a block the user asked for,
 * numbered and deletable — while differing in what the picture *is*. That difference is stated,
 * never implied: a sketch says outright that there is no timecode to seek to.
 *
 * `fallbackOrdinal` is used only by an older payload whose capture carries no `ref`. Without it
 * two anonymous pictures both read `### Handwriting`, and a document with two identical
 * headings is ambiguous to every reader, human or otherwise.
 */
function renderCaptureBlock(capture: InkCapture, fallbackOrdinal: number | null): string {
  const name = capture.board ? "Sketch" : "Handwriting";
  const heading =
    capture.ref ?? (fallbackOrdinal === null ? name : `${name} ${fallbackOrdinal}`);
  const lines: string[] = [`### ${heading}`];

  if (capture.board) {
    lines.push("- What this is: a sketch the user drew on a blank page, at the video's size.");
    lines.push("- The page is **not** a moment of the video; do not look for it in the composition.");
  } else {
    lines.push(`- Composition: \`${capture.compositionPath}\``);
    lines.push(`- Timecode: ${formatTimecode(capture.time)} (${capture.time.toFixed(3)}s)`);
    lines.push("- What this is: the frame as the user drew on it.");
  }
  if (typeof capture.strokes === "number" && capture.strokes > 0) {
    lines.push(`- Strokes in this picture: ${capture.strokes}`);
  }
  lines.push(`- Image: \`${capture.imagePath}\``);
  return lines.join("\n");
}

/**
 * Shared assembly: envelope, request, timecodes, targets, pictures, guardrails.
 *
 * The section names and the guardrails come from `requestFormat.ts`, which Studio's own
 * element prompt also uses. That is the whole point of the shared module: a prompt from
 * this layer and a prompt copied out of Studio must read as the same document with a
 * different body.
 */
function renderSections(bundle: AnnotationBundle, requestBody: string): string {
  /*
   * One heading for both callers.
   *
   * `renderBundle` used to pass "Overview" and `renderUserPrompt` "What I want", so the
   * same section had two names depending on how it was produced. A reader cannot tell
   * whether that difference means anything, so the section has one name now.
   */
  const heading = REQUEST_SECTIONS.want;
  const blocks: string[] = [
    [
      ...requestHeader(),
      "",
      /*
       * "the current video" was wrong more often than right.
       *
       * A request can name several compositions (one project embeds others), and a board sketch
       * names none at all. A sentence that asserts "the current video" makes the reader assume a
       * single file and a single playhead, and then the per-block locators below contradict it.
       * Saying what was annotated, without claiming which file, keeps the header true in every
       * case — the composition names arrive in `Where to look`.
       */
      "The user annotated frames in HyperFrames Studio. Please make these changes to this project.",
      "",
      `- Project directory: \`${bundle.projectDir}\``,
      /*
       * Only counts that exist.
       *
       * "Annotations: 0" reads like a failed delivery when the payload is deliberately
       * handwriting-only, and a bare total hides **what** is in the request — which is the first
       * thing a reader needs. The total is stated once, then broken down by kind.
       */
      `- Blocks: ${blockCount(bundle)}`,
      ...(bundle.annotations.length > 0
        ? [`  - Numbered marks (regions and arrows): ${bundle.annotations.length}`]
        : []),
      ...((bundle.elements ?? []).length > 0
        ? [`  - Selected elements: ${(bundle.elements ?? []).length}`]
        : []),
      ...handwritingSummary(bundle),
      ...(boardCount(bundle) > 0 ? [`  - Whiteboard sketches: ${boardCount(bundle)}`] : []),
    ].join("\n"),
  ];

  if (requestBody.trim()) {
    blocks.push(`${heading}\n\n${requestBody.trim()}`);
  }

  /*
   * The references, before any detail: a reader should be able to resolve every name in the
   * user's sentence first, then read what each one is.
   */
  const blockList = blockListSection(bundle);
  if (blockList) blocks.push(blockList);

  const whereToLook = whereToLookSection(bundle);
  if (whereToLook) blocks.push(whereToLook);

  /*
   * Every block in **one** section, in request order.
   *
   * ## Why not three sections
   *
   * Marks, elements and pictures used to live in three places: `## Targets` held the numbered
   * marks, elements were appended after it without a section of their own, and `## Handwriting`
   * held the pictures. A request therefore read `Region 1`, `Arrow 3`, `Element 2` — the order of
   * *kinds*, not of numbers — while the reference list at the top said 1, 2, 3.
   *
   * A reader looking for `Element 2` had to scan past blocks with larger numbers to find it, and
   * could reasonably conclude the numbering was broken. Now a block is met exactly once, in the
   * order its number claims, wherever it lives.
   */
  const blockSections = renderBlockDetails(bundle);
  if (blockSections.length > 0) {
    blocks.push([REQUEST_SECTIONS.targets, ...blockSections].join("\n\n"));
  }

  blocks.push(renderWhatToDo());

  return `${blocks.join("\n\n")}\n`;
}

/**
 * Render the whole bundle into the prompt that actually gets delivered.
 *
 * The structure is deliberately stable: context first, then one block per
 * annotation, then the concrete request. The agent does not need to parse it and a
 * human can read it — the same text serves both readers.
 */
export function renderBundle(bundle: AnnotationBundle): string {
  return renderSections(bundle, bundle.summary);
}

/**
 * Render the delivered prompt when the user wrote their own text in the prompt box.
 *
 * ## Why this cannot simply send the user's text
 *
 * The prompt box deliberately shows **block references only** (`Region 1`, `Arrow 2`)
 * — no coordinates, no timecodes, no screenshot paths. Sending that text alone would
 * hand the agent a sentence it cannot act on, because the machine details that give
 * those references meaning live in the annotation objects.
 *
 * So the user's words become the request, and the full details are appended below
 * them. The heading of each detail block is the same block reference the user typed,
 * so `Region 1` in their sentence resolves to `### Region 1` further down.
 */
export function renderUserPrompt(bundle: AnnotationBundle, userText: string): string {
  if (!userText.trim()) return renderBundle(bundle);
  return renderSections(bundle, userText);
}

/**
 * Render the delivered prompt for a bundle that may also carry elements.
 *
 * A separate name rather than changing `renderUserPrompt`'s meaning: the bundle already
 * distinguishes marks from elements, and one entry point that handles both keeps the
 * caller from having to know which sections exist.
 */
export function renderBundleWithElements(bundle: AnnotationBundle, userText: string): string {
  return renderUserPrompt(bundle, userText);
}
