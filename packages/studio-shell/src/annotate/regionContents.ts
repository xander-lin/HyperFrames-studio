/**
 * What a region actually **contains**.
 *
 * ## Why a rectangle's coordinates are not enough
 *
 * The prompt used to describe a region as `x 32.1%–58.4%, y 41.2%–63.9%`. A reader has to
 * translate that into "which element is that" by re-measuring the page — which it cannot do
 * from a picture, and should not have to do at all. The user circled something; the useful
 * fact is **what was circled**.
 *
 * So a region carries the elements its rectangle touches: their identity (tag, stable id,
 * selector, text) drawn from the same description an arrow uses. Coordinates stay, but as
 * corroboration rather than as the only content.
 *
 * ## Why "touches" rather than "is fully inside"
 *
 * A user circling a paragraph rarely lands exactly on its box — the stroke is hand-drawn.
 * Requiring full containment would report "nothing here" for a perfectly clear gesture.
 * Requiring only an intersection would report a full-screen background layer as contained by
 * every circle, so containment is judged by **area overlap**: an element counts when a
 * meaningful share of it (or of the circle) is inside the rectangle.
 */

import type { ElementRef, Rect } from "@mystudio/protocol";

/** Minimum share of overlap, either of the element inside the region or vice versa. */
const MIN_OVERLAP_RATIO = 0.25;

/** How many elements a region may name before the list stops being readable. */
const MAX_ELEMENTS = 8;

/** Elements a rectangle touches, most relevant first. */
export interface RegionContents {
  /** The element under the rectangle's centre, when there is one. */
  readonly primary: ElementRef | null;
  /** Others that overlap it, largest overlap first. */
  readonly others: readonly ElementRef[];
  /** How many candidates were seen before trimming, so "and N more" is honest. */
  readonly seen: number;
}

export interface CandidateElement {
  readonly element: Element;
  readonly box: Rect;
  /** Page area of the element, normalized; used to rank overlaps. */
  readonly area: number;
}

/**
 * Pick the elements a normalized rectangle touches.
 *
 * `candidates` are supplied by the caller (the DOM walk lives with the other DOM code), and
 * this function is pure so the overlap rule can be tested without a browser.
 */
export function pickRegionsContents(
  region: Rect,
  candidates: readonly CandidateElement[],
  describe: (element: Element) => ElementRef,
): RegionContents {
  const regionArea = Math.max(0, region.width) * Math.max(0, region.height);
  if (regionArea <= 0) return { primary: null, others: [], seen: 0 };

  const scored = candidates
    .map((candidate) => ({
      candidate,
      overlap: overlapArea(region, candidate.box),
    }))
    .filter((entry) => entry.overlap > 0)
    .filter((entry) => {
      /*
       * Either most of the element is inside the circle, or the circle is mostly filled by
       * the element. Both directions matter: a big paragraph partly circled is a hit, and a
       * small button well inside a big circle is also a hit.
       */
      const elementArea = Math.max(entry.candidate.area, 1e-9);
      const ofElement = entry.overlap / elementArea;
      const ofRegion = entry.overlap / regionArea;
      return ofElement >= MIN_OVERLAP_RATIO || ofRegion >= MIN_OVERLAP_RATIO;
    })
    /*
     * Rank by how much of the **element** the circle covers: circling a small label should
     * name the label, not the page container it happens to sit inside.
     */
    .sort((a, b) => {
      const ratioA = a.overlap / Math.max(a.candidate.area, 1e-9);
      const ratioB = b.overlap / Math.max(b.candidate.area, 1e-9);
      if (ratioB !== ratioA) return ratioB - ratioA;
      return b.overlap - a.overlap;
    });

  const primaryEntry = scored[0];
  if (!primaryEntry) return { primary: null, others: [], seen: 0 };

  const others = scored
    .slice(1)
    .slice(0, MAX_ELEMENTS)
    .map((entry) => describe(entry.candidate.element));

  return {
    primary: describe(primaryEntry.candidate.element),
    others,
    seen: scored.length,
  };
}

/** Intersection area of two normalized rectangles. */
export function overlapArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/** The point at the centre of a rectangle. */
export function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
