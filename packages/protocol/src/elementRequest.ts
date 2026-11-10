/**
 * Building the same request document from a **selected element**.
 *
 * ## Why this exists next to `prompt.ts`
 *
 * `prompt.ts` builds a request from spatial annotations: numbered marks, handwriting, a
 * picture of the frame. Studio's own prompt builds one from a selected element and a
 * sentence. Both are "make this change to this project", so both produce the document
 * described in `requestFormat.ts` — same title, same version, same section names, same
 * guardrails.
 *
 * The envelope is the shared part and lives in one place. What differs is the `Targets`
 * section: an annotation is described by where it is on the frame, an element by what it
 * is in the DOM.
 *
 * ## Why an element target carries no picture
 *
 * An annotation needs a picture because "the thing at 32% across" has no other identity.
 * An element does not: it has a selector, a tag, its text, and a source file. The reader
 * can open the file and find it exactly. Attaching a screenshot would add a second, less
 * precise description of something already identified — which invites acting on the
 * picture's pixels instead of the DOM the project is actually made of.
 */

import {
  REQUEST_SCHEMA_VERSION,
  REQUEST_SECTIONS,
  REQUEST_TITLE,
  renderWhatToDo,
} from "./requestFormat.js";
import { formatTimecode } from "./annotation.js";

/* The target shape lives in `annotation.ts`, beside the bundle that carries it: both
 * producers hand the same structure to the same renderer, so a second definition here
 * would be one more thing that could disagree with it. */
import type { ElementTarget } from "./annotation.js";
export type { ElementTarget } from "./annotation.js";

export interface ElementRequestInput {
  /** Project root; absolute, because the reader must be able to open it. */
  readonly projectDir: string;
  /** Composition the element lives in, relative to the project root. */
  readonly compositionPath: string;
  /** Playhead position in that composition, in seconds. */
  readonly time: number;
  /** The element being changed. */
  readonly target: ElementTarget;
  /**
   * The user's own words.
   *
   * Passed through verbatim. Rewriting it — trimming, rewording, "improving" — would be
   * inventing intent, and the reader would then be acting on the writer's paraphrase
   * rather than on what the user asked for.
   */
  readonly instruction: string;
  /** The element's own HTML, when the caller could read it. */
  readonly markup?: string | null;
}

/** One element as a `Targets` entry. */
export function renderElementTarget(target: ElementTarget): string {
  const lines: string[] = [`### ${target.label?.trim() || `<${target.tagName.toLowerCase()}>`}`];

  lines.push(`- Tag: \`<${target.tagName.toLowerCase()}>\``);
  if (target.hfId) lines.push(`- Stable id: \`${target.hfId}\``);
  if (target.id) lines.push(`- DOM id: \`${target.id}\``);
  if (target.selector) {
    const index = target.selectorIndex ? ` (index ${target.selectorIndex})` : "";
    lines.push(`- Selector: \`${target.selector}\`${index}`);
  }
  if (target.sourceFile) lines.push(`- Source file: \`${target.sourceFile}\``);
  if (target.src) lines.push(`- Media source: \`${target.src}\``);
  if (target.box) {
    const { x, y, width, height } = target.box;
    lines.push(
      `- Box (composition pixels): x=${Math.round(x)}, y=${Math.round(y)}, w=${Math.round(width)}, h=${Math.round(height)}`,
    );
  }
  if (target.text?.trim()) {
    const collapsed = target.text.replace(/\s+/g, " ").trim();
    const clipped = collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
    lines.push(`- Text: ${clipped}`);
  }
  return lines.join("\n");
}

/**
 * The whole request, for a selected element.
 *
 * Same envelope as a delivered annotation bundle: title, version, request, location,
 * targets, guardrails. The only structural difference is that the location names a
 * source file instead of a capture, and there is no picture section — see the module
 * comment for why.
 */
export function renderElementRequest(input: ElementRequestInput): string {
  const blocks: string[] = [];

  blocks.push(
    [
      REQUEST_TITLE,
      `Schema version: ${REQUEST_SCHEMA_VERSION}`,
      "",
      "I selected an element in HyperFrames Studio. Please make this change to this project.",
      "",
      `- Project directory: \`${input.projectDir}\``,
      `- Composition: \`${input.compositionPath}\``,
      `- Timecode: ${formatTimecode(input.time)} (${input.time.toFixed(3)}s)`,
    ].join("\n"),
  );

  if (input.instruction.trim()) {
    blocks.push(`${REQUEST_SECTIONS.want}\n\n${input.instruction.trim()}`);
  }

  blocks.push([REQUEST_SECTIONS.targets, "", renderElementTarget(input.target)].join("\n"));

  if (input.markup?.trim()) {
    // Its own section and fenced: it is code, and the reader has to be able to tell
    // exactly where it starts and stops.
    blocks.push(["## Target HTML", "", "```html", input.markup.trim(), "```"].join("\n"));
  }

  blocks.push(renderWhatToDo());

  return `${blocks.join("\n\n")}\n`;
}
