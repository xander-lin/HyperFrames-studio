/**
 * The one prompt format, shared by both injection paths.
 *
 * ## Why this module exists
 *
 * HyperFrames Studio already had an agent prompt: select an element, describe a change,
 * copy the text, paste it into a chat. This project added a second one — spatial
 * annotations that are delivered automatically. Two formats meant an agent (and a user)
 * had to understand two shapes for one idea: *"change this thing, here is why"*.
 *
 * So the format is defined **once**, here, and both paths read it:
 *
 * - the annotation layer builds a request from numbered marks, handwriting and the
 *   user's instruction;
 * - the Studio element prompt builds one from a selected element and an instruction.
 *
 * The two produce the same envelope, so an agent reads them the same way, and a prompt
 * copied from Studio can be pasted next to one that arrived through the plugin without
 * either looking foreign.
 *
 * ## Why the envelope has this shape
 *
 * The order answers the questions a reader asks in order:
 *
 * 1. **What am I looking at** — the title and the schema version. The version is not
 *    decoration: a receiver must be able to reject a payload it does not understand.
 * 2. **What does the user want** — their own words, first and verbatim. Everything below
 *    exists to give those words meaning.
 * 3. **Where** — project, composition, timecode.
 * 4. **What** — the numbered targets the instruction refers to, then any pictures.
 * 5. **How to proceed** — the guardrails, identical in every request.
 *
 * A user's sentence stays unedited: rewriting it would be inventing intent.
 */

/** Version of the request document. Bump when a section changes meaning. */
export const REQUEST_SCHEMA_VERSION = 3;

/** Title line. Same words for both producers. */
export const REQUEST_TITLE = `## HyperFrames change request v${REQUEST_SCHEMA_VERSION}`;

/** Section headings. Constants because two files must not drift apart. */
export const REQUEST_SECTIONS = {
  want: "## What I want",
  targets: "## Targets",
  handwriting: "## Handwriting",
  whatToDo: "## What to do",
} as const;

/**
 * The closing instructions, shared by every producer.
 *
 * Kept here rather than duplicated because the difference between the two paths is
 * *what* is being changed, not *how* the reader should work. A separate copy per
 * producer is how they silently diverge: one gets a new rule, the other keeps the old
 * one, and the user cannot tell which prompt they are looking at.
 */
export const REQUEST_GUARDRAILS: readonly string[] = [
  "1. Read `Where to look` first: it lists, per composition, the exact timecodes that the blocks below refer to. Different compositions have independent playheads, so never compare a timecode from one file with a timecode from another.",
  "2. Open each composition named there, seek to its timecode, and confirm the frame matches the capture before changing anything.",
  "3. Change only what the request names. Leave the rest of the composition and its timing alone.",
  "4. Where a target is a location rather than an element, interpret it against the frame at that timecode.",
  "5. Where the user wrote or drew directly on the frame, treat the handwriting as their instruction: read it, do not reproduce it in the output.",
  "6. A `Drawing N` block is a sketch on a blank page, not a frame of the video: there is no timecode to seek to and no footage to compare it against.",
  "7. Prefer the element's existing inline styles or CSS rules over adding unrelated selectors.",
  "8. Verify with `npx hyperframes lint` and `npx hyperframes check` once you are done.",
  "9. Reply with one sentence naming what you changed and at which timecode.",
];

/** Build the two-line header block. */
export function requestHeader(): string[] {
  return [REQUEST_TITLE, `Schema version: ${REQUEST_SCHEMA_VERSION}`];
}

/**
 * The `What to do` block.
 *
 * Numbering is done here so a caller adding a line cannot produce two entries numbered
 * the same, which reads as a mistake and hides that there are two rules.
 */
export function renderWhatToDo(): string {
  return [REQUEST_SECTIONS.whatToDo, "", ...REQUEST_GUARDRAILS].join("\n");
}
