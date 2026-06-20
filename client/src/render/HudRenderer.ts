/**
 * HUD strip (screen-space, below the arena):
 * - banner: match phase (PLAYING / VICTORY / DRAW);
 * - controls hint (configurable: hotseat default, net mode passes its own
 *   text via setHint — same for the "R to restart" suffix, which only the
 *   hotseat mode can honour);
 * - one row per player: slot color swatch + a tidy readout of status /
 *   fire / cannon / speed, plus the shell countdown while trapped.
 *
 * Layout: two fixed rows above the player grid, then 2 players per row in
 * the lower section for compact fit in the 112px strip.
 *
 * Note: PlayerState has no `hp` field — lives are spec'd at 1 and the sim
 * tracks `alive` only, so hp renders as alive ? 1 : 0.
 */
import { Container, Graphics, Text, type TextStyle } from 'pixi.js';
import { GamePhase } from '../../../shared/types';
import { MAP_COLS, MATCH_MAX_TICKS, TICK_HZ, TILE_PX } from '../../../shared/constants';
import type { SimState } from '../sim/Sim';
import { resolveOutcome } from '../sim/Outcome';
import { playerColor } from './PlayerRenderer';

export const HUD_HEIGHT_PX = 112;

/** Default controls hint (the local hotseat mode). */
export const HOTSEAT_HINT =
  'Local hotseat — P1: WASD + Space · P2: Arrows + Enter · R: reset';

const HUD_W   = MAP_COLS * TILE_PX;  // 660
const PAD     = 10;
const SWATCH  = 12;
const ROW_H   = 22;
const ROW0_Y  = 50; // y of first player row (below banner + hint)

const BANNER_STYLE: Partial<TextStyle> = {
  fontFamily: 'monospace',
  fontSize: 15,
  fontWeight: 'bold',
  fill: 0xffd966,
} as Partial<TextStyle>;

const HINT_STYLE: Partial<TextStyle> = {
  fontFamily: 'monospace',
  fontSize: 12,
  fill: 0xb9a489,
} as Partial<TextStyle>;

const ROW_STYLE: Partial<TextStyle> = {
  fontFamily: 'monospace',
  fontSize: 12,
  fill: 0xf6e3c5,
} as Partial<TextStyle>;

const TRAP_STYLE: Partial<TextStyle> = {
  fontFamily: 'monospace',
  fontSize: 12,
  fontWeight: 'bold',
  fill: 0xffcc44,
} as Partial<TextStyle>;

const OUT_STYLE: Partial<TextStyle> = {
  fontFamily: 'monospace',
  fontSize: 12,
  fill: 0x7a6048,
} as Partial<TextStyle>;

interface PlayerRow {
  swatch: Graphics;
  text: Text;
}

export class HudRenderer {
  readonly container = new Container();
  private readonly banner: Text;
  private readonly hint: Text;
  private readonly rows: PlayerRow[] = [];
  /** Append "(R to restart)" to end-of-match banners (hotseat only). */
  private restartHint = true;
  /**
   * Render-only per-slot labels (strategy / difficulty / "YOU"); index = slot.
   * Purely cosmetic — NEVER read from or written to SimState / stateHash.
   */
  private slotLabels: ReadonlyArray<string | undefined> = [];

  constructor(hintText: string = HOTSEAT_HINT) {
    // Dark chocolate HUD background
    const bg = new Graphics();
    bg.rect(0, 0, HUD_W, HUD_HEIGHT_PX).fill(0x1e1108);
    // Subtle top separator line
    bg.rect(0, 0, HUD_W, 2).fill(0x5a3018);
    this.container.addChild(bg);

    // Phase banner
    this.banner = new Text({ text: '', style: BANNER_STYLE });
    this.banner.position.set(PAD, 6);
    this.container.addChild(this.banner);

    // Controls hint
    this.hint = new Text({ text: hintText, style: HINT_STYLE });
    this.hint.position.set(PAD, 28);
    this.container.addChild(this.hint);

    // Separator line between hint and player rows
    const sep = new Graphics();
    sep.rect(PAD, ROW0_Y - 5, HUD_W - PAD * 2, 1).fill({ color: 0x5a3018, alpha: 0.6 });
    this.container.addChild(sep);
  }

  /** Swap the controls hint (net mode: "Online — you are P2 …"). */
  setHint(text: string, restartHint: boolean = true): void {
    this.hint.text = text;
    this.restartHint = restartHint;
  }

  /**
   * Set the per-slot HUD labels (index = player slot). Cosmetic only — these
   * are appended to each player row (e.g. "[Aggressor]" / "[YOU]") and never
   * influence simulation state.
   */
  setSlotLabels(labels: ReadonlyArray<string | undefined>): void {
    this.slotLabels = labels;
  }

  update(next: SimState): void {
    this.banner.text = bannerText(next, this.restartHint);

    for (let i = 0; i < next.players.length; i++) {
      const pl = next.players[i];
      if (pl === undefined) continue;
      let row = this.rows[i];
      if (row === undefined) {
        const swatch = new Graphics();
        swatch.roundRect(0, 0, SWATCH, SWATCH, 3).fill(playerColor(pl.team));
        // Two players per row, side by side: P1+P2 on row 0, P3+P4 on row 1
        const col  = i % 2;          // 0 = left half, 1 = right half
        const rowN = Math.floor(i / 2);
        const xBase = col === 0 ? PAD : HUD_W / 2 + PAD;
        const yBase = ROW0_Y + rowN * ROW_H;
        swatch.position.set(xBase, yBase);
        const text = new Text({ text: '', style: ROW_STYLE });
        text.position.set(xBase + SWATCH + 6, yBase - 1);
        this.container.addChild(swatch, text);
        row = { swatch, text };
        this.rows[i] = row;
      }
      // Update text style to reflect status
      const { text, label, style } = playerLineInfo(
        pl.slot,
        pl,
        this.slotLabels[pl.slot],
      );
      void label; // label embedded in text
      row.text.style = { ...style };
      row.text.text = text;
    }
  }
}

function bannerText(state: SimState, restartHint: boolean): string {
  if (state.phase === GamePhase.PLAYING) return 'PLAYING — last team standing wins!';
  if (state.phase === GamePhase.OVER) {
    const suffix = restartHint ? ' (R to restart)' : '';
    const { winnerTeam } = resolveOutcome(state);
    if (winnerTeam === null) {
      // Genuine draw: distinguish a wipe-out from a tick-cap dead heat.
      return state.players.some((p) => p.alive)
        ? `DRAW — time up, dead heat.${suffix}`
        : `DRAW — everyone crystallized.${suffix}`;
    }
    return state.tick >= MATCH_MAX_TICKS
      ? `TIME UP — team ${winnerTeam} wins (survivors / items)!${suffix}`
      : `VICTORY — last team standing!${suffix}`;
  }
  return 'LOBBY';
}

function playerLineInfo(
  slot: number,
  pl: {
    alive: boolean;
    trapped: boolean;
    trappedTicks: number;
    fire: number;
    cannon: number;
    activeBombs: number;
    speedBonusTenths: number;
  },
  slotLabel?: string,
): { text: string; label: string; style: Partial<TextStyle> } {
  const label = `P${slot + 1}`;
  const spd = (pl.speedBonusTenths / 10).toFixed(1);
  // Render-only strategy / difficulty tag (e.g. " [Aggressor]" / " [YOU]").
  const tag = slotLabel === undefined ? '' : ` [${slotLabel}]`;

  if (!pl.alive) {
    return {
      label,
      text: `P${slot + 1} OUT${tag}`,
      style: OUT_STYLE,
    };
  }

  if (pl.trapped) {
    const secs = (pl.trappedTicks / TICK_HZ).toFixed(1);
    return {
      label,
      text: `P${slot + 1} SHELL ${secs}s${tag}  fire ${pl.fire}  x${pl.activeBombs}/${pl.cannon}  +${spd}`,
      style: TRAP_STYLE,
    };
  }

  return {
    label,
    text: `P${slot + 1} ALIVE${tag}  fire ${pl.fire}  x${pl.activeBombs}/${pl.cannon}  +${spd}`,
    style: ROW_STYLE,
  };
}
