/**
 * FeelPanel: DOM settings panel for the panel-adjustable feel parameters
 * (CLAUDE.md「手感參數（面板可調）」). HOTSEAT ONLY — feel params feed the
 * sim, so in online mode both clients must keep the identical MatchStart
 * config; netMode never constructs this panel.
 *
 * Apply model: releasing a slider (the `change` event, not every `input`
 * step) fires `onApply(feel)`; main.ts rebuilds the initial state from the
 * SAME fixed seed — exactly an R-reset with new params. Live readouts update
 * while dragging; the round only restarts on release. This is the "rebuild
 * like R-reset, keeping the seed" option from the M6 spec, chosen because a
 * mid-match param swap would silently produce states no fresh match could
 * reach (and would desync any future replay of the run).
 *
 * Visuals are original DOM (chocolate palette, matching LobbyUI) — no
 * copyrighted assets.
 */
import {
  DEFAULT_CORNER_ASSIST,
  DEFAULT_INPUT_BUFFER_MS,
  DEFAULT_MOVE_SPEED,
} from '../../../shared/constants';
import { type FeelParams, makeFeelParams } from '../config/FeelParams';

const PALETTE = {
  card: 'rgba(46, 26, 12, 0.96)',
  text: '#f5e6d3',
  accent: '#ffb74d',
  soft: '#cfb497',
  button: '#6b3f1d',
};

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Format the readout (units included). */
  format: (v: number) => string;
}

const SLIDERS: Record<keyof FeelParams, SliderSpec> = {
  moveSpeed: {
    label: 'Move speed',
    min: 3,
    max: 8,
    step: 0.1,
    default: DEFAULT_MOVE_SPEED,
    format: (v) => `${v.toFixed(1)} tiles/s`,
  },
  cornerAssist: {
    label: 'Corner assist',
    min: 0,
    max: 0.5,
    step: 0.05,
    default: DEFAULT_CORNER_ASSIST,
    format: (v) => `${v.toFixed(2)} tiles`,
  },
  inputBufferMs: {
    label: 'Input buffer',
    min: 0,
    max: 250,
    step: 10,
    default: DEFAULT_INPUT_BUFFER_MS,
    format: (v) => `${Math.round(v)} ms`,
  },
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  parent?.appendChild(node);
  return node;
}

interface Row {
  key: keyof FeelParams;
  slider: HTMLInputElement;
  readout: HTMLSpanElement;
}

export class FeelPanel {
  /** Mount both into the document (gear floats fixed; panel sits beside it). */
  readonly root: HTMLDivElement;
  /** Fired on slider release / reset with the new (clamped) params. */
  onApply: ((feel: FeelParams) => void) | null = null;

  private readonly panel: HTMLDivElement;
  private readonly rows: Row[] = [];
  private open = false;

  constructor() {
    this.root = el(
      'div',
      ['position:fixed', 'top:10px', 'right:10px', 'z-index:30',
        'font:13px/1.5 system-ui,sans-serif', `color:${PALETTE.text}`,
        'text-align:right'].join(';'),
    );

    const gear = el(
      'button',
      ['cursor:pointer', 'border:none', 'border-radius:10px',
        'padding:7px 12px', `background:${PALETTE.button}`,
        `color:${PALETTE.text}`, 'font:14px system-ui,sans-serif',
        'box-shadow:0 2px 8px rgba(43,26,14,0.4)'].join(';'),
      this.root,
    );
    gear.textContent = '⚙ Feel';
    gear.title = 'Feel parameters (hotseat only)';
    gear.addEventListener('click', () => this.toggle());

    this.panel = el(
      'div',
      ['display:none', 'margin-top:8px', 'width:264px', 'padding:14px 16px',
        `background:${PALETTE.card}`, 'border-radius:12px', 'text-align:left',
        'box-shadow:0 8px 28px rgba(43,26,14,0.45)'].join(';'),
      this.root,
    );

    const title = el(
      'div',
      `font-weight:600;color:${PALETTE.accent};margin-bottom:6px`,
      this.panel,
    );
    title.textContent = 'Feel parameters';

    for (const key of Object.keys(SLIDERS) as Array<keyof FeelParams>) {
      this.rows.push(this.buildRow(key, SLIDERS[key]));
    }

    const note = el(
      'div',
      `color:${PALETTE.soft};font-size:11px;margin:8px 0 10px`,
      this.panel,
    );
    note.textContent = 'Releasing a slider restarts the round (same seed).';

    const reset = el(
      'button',
      ['cursor:pointer', 'border:none', 'border-radius:8px', 'padding:6px 12px',
        `background:${PALETTE.button}`, `color:${PALETTE.text}`,
        'font:12px system-ui,sans-serif'].join(';'),
      this.panel,
    );
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      for (const row of this.rows) {
        row.slider.value = String(SLIDERS[row.key].default);
        this.refreshReadout(row);
      }
      this.apply();
    });

    // Sliders steal arrow keys while focused; without this, dragging a slider
    // would also drive P2 (arrows) through the window-level KeyboardInput.
    for (const type of ['keydown', 'keyup'] as const) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  private buildRow(key: keyof FeelParams, spec: SliderSpec): Row {
    const wrap = el('div', 'margin:8px 0 2px', this.panel);
    const head = el(
      'div',
      'display:flex;justify-content:space-between;margin-bottom:2px',
      wrap,
    );
    const label = el('span', `color:${PALETTE.text}`, head);
    label.textContent = spec.label;
    const readout = el('span', `color:${PALETTE.accent}`, head);

    const slider = el('input', 'width:100%;accent-color:#c87f33', wrap);
    slider.type = 'range';
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = String(spec.step);
    slider.value = String(spec.default);

    const row: Row = { key, slider, readout };
    this.refreshReadout(row);
    slider.addEventListener('input', () => this.refreshReadout(row));
    slider.addEventListener('change', () => {
      slider.blur(); // give the keyboard back to the game
      this.apply();
    });
    return row;
  }

  private refreshReadout(row: Row): void {
    row.readout.textContent = SLIDERS[row.key].format(Number(row.slider.value));
  }

  private apply(): void {
    const partial: Partial<Record<keyof FeelParams, number>> = {};
    for (const row of this.rows) partial[row.key] = Number(row.slider.value);
    this.onApply?.(makeFeelParams(partial));
  }

  toggle(): void {
    this.open = !this.open;
    this.panel.style.display = this.open ? 'block' : 'none';
  }
}
