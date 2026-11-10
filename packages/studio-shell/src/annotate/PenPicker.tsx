/**
 * The pen: a colour button, a size button, and the panels they open.
 *
 * ## Why colour and size are two buttons
 *
 * They were one, with the weight hidden behind a second step inside the colour palette.
 * That reads as "weight belongs to colour", which is not true: a user changes weight far
 * more often than colour (they pick a colour once per task and then thicken and thin the
 * line constantly), and having to open the colour palette to reach it made the common
 * action the hidden one.
 *
 * ## Why the panels are not rendered here
 *
 * A panel that is a child of the scrolling tool column gets **clipped** by it — that is
 * exactly how the old palette broke. So this module exports the triggers and the panel
 * *contents* separately; the toolbar renders the contents at its own root level
 * (`DockSubmenu`), which is inside the toolbar's stacking context and moves with it.
 */

import { PEN_COLOURS, PEN_WIDTHS, penWidthIndex } from "./penStyle.js";
import type { PenStyle } from "./penStyle.js";

export { PEN_COLOURS, PEN_WIDTHS, penWidthIndex, DEFAULT_PEN, BOARD_PAPER } from "./penStyle.js";
export type { PenStyle } from "./penStyle.js";

/** A square trigger that shows the current pen. */
export function PenColourTrigger(props: {
  readonly pen: PenStyle;
  readonly open: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** The button itself, so the panel can be anchored to it. */
  readonly anchorRef?: React.Ref<HTMLButtonElement>;
}) {
  const name = PEN_COLOURS.find(
    (colour) => colour.value.toLowerCase() === props.pen.colour.toLowerCase(),
  )?.name;
  return (
    <button
      ref={props.anchorRef}
      type="button"
      data-mystudio-overlay="pen-colour-trigger"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-haspopup="dialog"
      aria-expanded={props.open}
      aria-label="Pen colour"
      title={`Pen colour: ${name ?? props.pen.colour}`}
      style={triggerStyle(props.open, props.disabled === true)}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 999,
          background: props.pen.colour,
          border: "1px solid color-mix(in oklab, var(--color-text-3) 45%, transparent)",
        }}
      />
    </button>
  );
}

/**
 * A trigger whose glyph is the pen's **thickness**.
 *
 * The preview is the whole point: a generic "line weight" icon would make the user open the
 * panel to find out what they are currently drawing with.
 */
export function PenWidthTrigger(props: {
  readonly pen: PenStyle;
  readonly open: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** The button itself, so the panel can be anchored to it. */
  readonly anchorRef?: React.Ref<HTMLButtonElement>;
}) {
  const size = Math.min(13, Math.max(3, props.pen.width * 1.9));
  return (
    <button
      ref={props.anchorRef}
      type="button"
      data-mystudio-overlay="pen-width-trigger"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-haspopup="dialog"
      aria-expanded={props.open}
      aria-label="Pen thickness"
      title={`Pen thickness: ${props.pen.width}px`}
      style={triggerStyle(props.open, props.disabled === true)}
    >
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 999,
          // The bar is drawn with the pen's own colour, at the pen's own weight.
          background: props.pen.colour,
          boxShadow: "0 0 0 1px color-mix(in oklab, var(--color-text-3) 30%, transparent)",
        }}
      />
    </button>
  );
}

function triggerStyle(open: boolean, disabled: boolean): React.CSSProperties {
  return {
    width: 30,
    height: 22,
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderRadius: "var(--radius-sm, 4px)",
    border: "none",
    background: open ? "color-mix(in oklab, var(--color-accent) 22%, transparent)" : "transparent",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

/** Six swatches on one row. No heading, no weight row: this panel is only about colour. */
export function PenColourPanel(props: {
  readonly pen: PenStyle;
  readonly onChange: (pen: PenStyle) => void;
  readonly lightSurface?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {PEN_COLOURS.map((colour) => {
        const active = props.pen.colour.toLowerCase() === colour.value.toLowerCase();
        const pointless = props.lightSurface === true && colour.value === "#ffffff";
        return (
          <button
            key={colour.value}
            type="button"
            onClick={() => props.onChange({ ...props.pen, colour: colour.value })}
            title={pointless ? `${colour.name} — invisible on paper` : colour.name}
            aria-label={colour.name}
            aria-pressed={active}
            style={{
              width: 18,
              height: 18,
              padding: 0,
              borderRadius: 999,
              cursor: "pointer",
              background: colour.value,
              border: active
                ? "2px solid var(--color-text-0)"
                : "1px solid color-mix(in oklab, var(--color-text-3) 45%, transparent)",
              opacity: pointless ? 0.35 : 1,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Thickness as a **stepped** control: `−  3px  +`.
 *
 * One row, no label column, no preview strip. Seven rows of buttons doubled the panel's
 * height for a choice made once, and a slider asks the user to aim at a number they cannot
 * see; stepping asks the only question that matters — thicker or thinner.
 */
export function PenWidthPanel(props: {
  readonly pen: PenStyle;
  readonly onChange: (pen: PenStyle) => void;
}) {
  const index = penWidthIndex(props.pen.width);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <StepButton
        glyph="−"
        label="Thinner"
        enabled={index > 0}
        onClick={() => props.onChange({ ...props.pen, width: PEN_WIDTHS[index - 1]!.value })}
      />
      <span
        data-mystudio-overlay="pen-width-label"
        title={PEN_WIDTHS[index]?.name ?? "custom"}
        style={{
          minWidth: 38,
          textAlign: "center",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
          color: "var(--color-text-1)",
        }}
      >
        {props.pen.width}px
      </span>
      <StepButton
        glyph="+"
        label="Thicker"
        enabled={index < PEN_WIDTHS.length - 1}
        onClick={() => props.onChange({ ...props.pen, width: PEN_WIDTHS[index + 1]!.value })}
      />
    </div>
  );
}

function StepButton(props: {
  readonly glyph: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-mystudio-overlay="pen-width-step"
      onClick={props.onClick}
      disabled={!props.enabled}
      title={props.label}
      aria-label={props.label}
      style={{
        width: 20,
        height: 20,
        display: "grid",
        placeItems: "center",
        padding: 0,
        borderRadius: "var(--radius-sm, 4px)",
        border: "none",
        background: "transparent",
        color: props.enabled ? "var(--color-text-2)" : "var(--color-text-off)",
        cursor: props.enabled ? "pointer" : "default",
        fontSize: 12,
        lineHeight: 1,
      }}
    >
      {props.glyph}
    </button>
  );
}
