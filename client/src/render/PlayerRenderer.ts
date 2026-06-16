/**
 * Player art: a rounded chocolate-piece body with:
 *  • a slot-specific accessible color (4 distinct hues)
 *  • a specular sheen oval at top-left to suggest a 3D glossy piece
 *  • a facing notch: a small bright triangular indent pointing in the
 *    direction the player is facing, so orientation is instantly readable
 *  • a subtle squash/stretch driven by alpha (sub-tick interpolation) to
 *    suggest momentum — purely cosmetic, does not touch sim state.
 *
 * Trap visuals (sugar shell + countdown) are drawn by ShellRenderer.
 * Eliminated players are hidden.
 */
import { Container, Graphics } from 'pixi.js';
import type { SimState } from '../sim/Sim';
import { dirDX, dirDY } from '../sim/Player';
import { interpEntityPx } from './interpolate';
import { Direction } from '../../../shared/types';

/** Per-slot body colors — accessible, distinct, chocolate-world tones. */
export const PLAYER_COLORS: readonly number[] = [
  0x3a7bd5, // slot 0: cornflower blue
  0xd5453a, // slot 1: brick red
  0x3aa655, // slot 2: leaf green
  0xd09a2e, // slot 3: caramel gold
];

export function playerColor(slot: number): number {
  return PLAYER_COLORS[slot] ?? 0x888888;
}

/** Slightly darker variant for the bottom shadow of the chocolate piece. */
const SHADOW_FACTOR = 0.6;
function darken(c: number): number {
  const r = ((c >> 16) & 0xff) * SHADOW_FACTOR;
  const g = ((c >> 8)  & 0xff) * SHADOW_FACTOR;
  const b = (c        & 0xff) * SHADOW_FACTOR;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

const BODY_HALF    = 15; // half of the 30×30 body
const CORNER_R     = 7;  // rounded corner radius
const NOTCH_REACH  = 16; // how far the facing notch sits from center
const NOTCH_HALF   = 5;  // half-width of the notch triangle base

export class PlayerRenderer {
  readonly container = new Container();
  private readonly pool = new Map<number, Graphics>();

  update(prev: SimState, next: SimState, alpha: number): void {
    const seen = new Set<number>();

    for (const pl of next.players) {
      seen.add(pl.slot);
      let g = this.pool.get(pl.slot);
      if (g === undefined) {
        g = new Graphics();
        this.pool.set(pl.slot, g);
        this.container.addChild(g);
      }

      if (!pl.alive) {
        g.visible = false;
        continue;
      }
      g.visible = true;

      const prevPl = prev.players.find((p) => p.slot === pl.slot);
      const { x, y } = interpEntityPx(prevPl, pl, alpha);
      g.position.set(x, y);

      // Subtle squash/stretch: slightly wider in movement direction
      // (purely cosmetic, driven by alpha for smoothness)
      const prevPosX = prevPl?.posX ?? pl.posX;
      const prevPosY = prevPl?.posY ?? pl.posY;
      const movingH  = Math.abs(pl.posX - prevPosX) > 0;
      const movingV  = Math.abs(pl.posY - prevPosY) > 0;
      const sx = movingH ? 1.06 : (movingV ? 0.94 : 1.0);
      const sy = movingV ? 1.06 : (movingH ? 0.94 : 1.0);
      // Blend from previous scale toward target using alpha (smooth interpolation)
      g.scale.set(1 + (sx - 1) * alpha, 1 + (sy - 1) * alpha);

      // Redraw geometry each frame (direction/color may change)
      g.clear();

      const col    = playerColor(pl.team);
      const dark   = darken(col);

      // Shadow / bottom layer (offset 2px down-right)
      g.roundRect(
        -BODY_HALF + 2,
        -BODY_HALF + 2,
        BODY_HALF * 2,
        BODY_HALF * 2,
        CORNER_R,
      ).fill({ color: dark, alpha: 0.55 });

      // Main body
      g.roundRect(-BODY_HALF, -BODY_HALF, BODY_HALF * 2, BODY_HALF * 2, CORNER_R)
       .fill(col);

      // Specular sheen: small bright ellipse at top-left
      g.ellipse(-6, -8, 7, 4).fill({ color: 0xffffff, alpha: 0.40 });

      // Facing notch: a bright rounded-diamond indicator in the facing direction
      const dx = dirDX(pl.facing);
      const dy = dirDY(pl.facing);
      drawFacingNotch(g, dx, dy);
    }

    for (const [slot, g] of this.pool) {
      if (!seen.has(slot)) g.visible = false;
    }
  }
}

/**
 * Draw a small bright arrowhead/notch at the edge of the body pointing toward
 * the facing direction.  Uses the Direction bit flags — dx/dy are ±1 or 0.
 */
function drawFacingNotch(g: Graphics, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;

  // Center of the notch (on the body edge)
  const nx = dx * NOTCH_REACH;
  const ny = dy * NOTCH_REACH;

  // Perpendicular unit vector for the base of the triangle
  const px = dy; // rotate (dx,dy) 90°
  const py = -dx;

  // Three vertices of a small filled triangle pointing outward
  const ax = nx + dx * NOTCH_HALF;
  const ay = ny + dy * NOTCH_HALF;
  const bx = nx - dx * NOTCH_HALF + px * NOTCH_HALF;
  const by = ny - dy * NOTCH_HALF + py * NOTCH_HALF;
  const cx = nx - dx * NOTCH_HALF - px * NOTCH_HALF;
  const cy2 = ny - dy * NOTCH_HALF - py * NOTCH_HALF;

  g.moveTo(ax, ay).lineTo(bx, by).lineTo(cx, cy2).closePath()
   .fill({ color: 0xfff4e0, alpha: 0.90 });
}

// Suppress unused import lint (Direction is used transitively via dirDX/dirDY)
void Direction;
