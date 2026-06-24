/**
 * Candy art — the "milk-cream" (牛奶奶油) visual language, ported tile-for-tile
 * from the `IsoArena` design comp (Choccus UI與地圖重設計/IsoArena.dc.html).
 *
 * Pure presentation: each builder returns a CSS string or an HTML string for a
 * stack of absolutely-positioned <div>s inside a TW×TH cell. The Renderer drops
 * these into pooled DOM nodes and only moves them (transform) per frame.
 *
 * Geometry: every entity is authored inside a single TW×TH cell with the tile
 * top-left at (0,0); cx/cy are the cell centre. Cubes raise a "top face" by
 * `pop` px to fake 2.5D depth; glows/blobs deliberately overflow the cell.
 */

import { ItemKind } from '../../../shared/types';

// Cell pitch (design: chunky 48-wide tiles, 44 tall) + board padding + cube pop.
export const TW = 48;
export const TH = 44;
export const PAD_X = 16;
// Top band hosts the floating timer pill (y 8–56), so keep tiles clear of it.
export const PAD_TOP = 62;
export const PAD_BOT = 14;
// Subtle thickness so tiles overlap the row behind (via per-row z-index in the
// Renderer) — a gentle layered look, not the old chunky 2.5D cube.
const POP_WALL = 7;
const POP_BLOCK = 5;
const CX = TW / 2; // 24
const CY = TH / 2; // 22

/** Per-team body palette (design `players[]`: pink · mint · caramel · blue). */
export const TEAM_PALETTE = [
  { hi: '#FFD9E3', base: '#F2849E', lo: '#D85F7C' }, // 0 strawberry
  { hi: '#CFF0E4', base: '#7FD1B9', lo: '#4FAF94' }, // 1 mint
  { hi: '#FBDEAE', base: '#E8A24A', lo: '#C57E25' }, // 2 caramel
  { hi: '#CFDBFB', base: '#8FA8E8', lo: '#6480D0' }, // 3 blueberry
] as const;

export function teamPalette(team: number): (typeof TEAM_PALETTE)[number] {
  return TEAM_PALETTE[team % TEAM_PALETTE.length] ?? TEAM_PALETTE[0];
}

const MILK = {
  grout: '#C99C63',
  floorA: '#EAC98E',
  floorB: '#E2BC80',
  wall: { hi: '#9A6A3E', base: '#5C3A1F', lo: '#2A1607' },
  block: { hi: '#FFF7E8', base: '#F2DFBC', lo: '#D6B988' },
  // Chocolate truffle (巧克力) = the bomb — the theme's own bomb material
  // (炸彈=巧克力 → 融化=爆炸). Glossy dark-ganache dome on a milk-chocolate base,
  // bright candy sprinkles + lit candle fuse + live pulse. Dark/round/lit/pulsing
  // reads apart from the PALE square cake-bricks (by hue, the strongest cue) AND
  // the matte dark walls (by gloss + round shape + the fuse).
  cakeHi: '#7A4A2A',
  cakeMid: '#4E2E18',
  cakeLo: '#2E1A0C',
  frostHi: '#5A361F',
  frostLo: '#241208',
  candle: '#F4869E',
  spark: '#FFE3A1',
  sparkGlow: '#FF9B3D',
  // Molten-chocolate melt-flow (融化的巧克力): the bomb's chocolate melting → a
  // warm caramel-amber stream over a saturated orange halo (the "火力"). The top
  // stays bright + a white-hot core/crest keeps the lethal reach legible on the
  // tan floor (full chocolate-brown would hide the kill zone). explShadow lifts it off.
  explGlow: 'rgba(255,116,24,.66)',
  explHi: '#FFF3D2',
  explMid: '#FBD896',
  explLo: '#EDB055',
  explShadow: 'rgba(120,64,22,.42)',
  eye: '#3A2A22',
  cheek: 'rgba(244,120,150,.55)',
} as const;

// Hardened dark-chocolate dome trapping a caught cutie (design SHELL): the same
// chocolate that melted to attack, now SET around the player — "一物兩用". Glossy
// dark ganache, cream-coloured eyes (only colour that reads through the dark).
const SHELL = {
  body: 'linear-gradient(168deg,#6B4423,#4A2C16 56%,#341d0e)',
  eye: '#FBE9C6',
  shell:
    'radial-gradient(circle at 34% 26%, rgba(255,236,210,.92), rgba(150,92,46,.5) 40%, rgba(74,44,22,.62) 70%, rgba(45,26,14,.72))',
} as const;

/** Per item kind: same candy diamond, tinted so kinds stay distinguishable. */
const ITEM_PAL: Record<number, { a: string; b: string; glow: string }> = {
  [ItemKind.FIRE]: { a: '#FFC8D8', b: '#F2849E', glow: 'rgba(242,132,158,.65)' },
  [ItemKind.SPEED]: { a: '#CFF0E4', b: '#7FD1B9', glow: 'rgba(127,209,185,.65)' },
  [ItemKind.CANNON]: { a: '#FBDEAE', b: '#E8A24A', glow: 'rgba(232,162,74,.6)' },
};

// ---------------------------------------------------------------------------
// Board + floor
// ---------------------------------------------------------------------------

export function boardCss(cols: number, rows: number): string {
  const w = cols * TW + PAD_X * 2;
  const h = rows * TH + PAD_TOP + PAD_BOT;
  return (
    `position:relative;width:${w}px;height:${h}px;` +
    `background:radial-gradient(130% 120% at 50% 28%,#FBEAD0,#EFD3A4);`
  );
}

export function boardSize(cols: number, rows: number): { w: number; h: number } {
  return { w: cols * TW + PAD_X * 2, h: rows * TH + PAD_TOP + PAD_BOT };
}

/** Pixel top-left of a tile cell (for tile-locked entities). */
export function cellLeft(tileX: number): number {
  return PAD_X + tileX * TW;
}
export function cellTop(tileY: number): number {
  return PAD_TOP + tileY * TH;
}

/** Floor under every cell: grout edge + checkerboard top. */
export function floorHtml(checker: number): string {
  const top = checker ? MILK.floorA : MILK.floorB;
  return (
    `<div style="position:absolute;inset:0;background:${MILK.grout};border-radius:6px;"></div>` +
    `<div style="position:absolute;left:1px;top:1px;width:${TW - 2}px;height:${TH - 2}px;` +
    `border-radius:6px;background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(0,0,0,.05)),${top};"></div>`
  );
}

/**
 * Simple-dessert tile with a *gentle* thickness: a flat dessert top raised by a
 * small `pop` over a soft side face — so front-row tiles overlap the row behind
 * (ordered by the Renderer's per-row z-index). No blurred cast shadow (that read
 * as a weird shadow band); the side IS the only depth cue. Hard wall = glossy
 * dark-chocolate; soft brick = layered cake (sponge + cream frosting cap).
 */
export function cubeHtml(kind: 'wall' | 'block' | 'push'): string {
  const pop = kind === 'wall' ? POP_WALL : POP_BLOCK;
  if (kind === 'push') {
    // Pushable brick = a Swiss-roll cake (瑞士捲): SAME cream-cake colour family
    // as the soft brick ("差不多"), but the top face shows a roll-cake SPIRAL —
    // concentric sponge/cream rings, the swirl of a roll-cake cross-section — so
    // it reads instantly as a *different kind of cake* you can shove ("有一點區別").
    const x = 2;
    const w = TW - 4;
    const topH = TH - 4;
    const sideTop = -pop + topH;
    const sideH = pop + 6;
    const cxp = x + w / 2;
    const cyc = -pop + topH / 2; // top-face centre
    // One concentric ring of the spiral, centred on the top face.
    const ring = (cw: number, ch: number, col: string): string =>
      `<div style="position:absolute;left:${cxp - cw / 2}px;top:${cyc - ch / 2}px;` +
      `width:${cw}px;height:${ch}px;border-radius:50%;background:${col};"></div>`;
    return (
      // sponge side (cake thickness)
      `<div style="position:absolute;left:${x}px;top:${sideTop}px;width:${w}px;height:${sideH}px;` +
      `border-radius:0 0 12px 12px;background:linear-gradient(180deg,#D8B87E,#BF9B5E);"></div>` +
      // sponge top face
      `<div style="position:absolute;left:${x}px;top:${-pop}px;width:${w}px;height:${topH}px;border-radius:12px 12px 0 0;` +
      `background:linear-gradient(180deg,#EFD6A6,#DCBC82);"></div>` +
      // roll-cake spiral: alternating sponge / cream rings, outer → centre
      ring(w - 6, topH - 8, '#C99B5A') +
      ring(w - 16, topH - 17, '#F3E2BC') +
      ring(w - 26, topH - 26, '#C99B5A') +
      ring(10, 9, '#F3E2BC') +
      `<div style="position:absolute;left:${cxp - 1.5}px;top:${cyc - 1.5}px;width:3px;height:3px;` +
      `border-radius:50%;background:#B5863F;"></div>`
    );
  }
  const x = 2;
  const w = TW - 4;
  const topH = TH - 4; // flat top surface
  const sideTop = -pop + topH; // flush with the top face's (square) bottom edge
  const sideH = pop + 6; // down to the cell bottom (+ slight overflow to overlap)
  if (kind === 'wall') {
    // Premium couverture: a deep 3-stop top + an embossed molded square (one
    // chocolate-bar segment) + a tempered sheen streak so it reads glossy and
    // rich, not a flat brown slab. Side darkens to `lo` = the thickness.
    const c = MILK.wall;
    return (
      `<div style="position:absolute;left:${x}px;top:${sideTop}px;width:${w}px;height:${sideH}px;` +
      `border-radius:0 0 12px 12px;background:linear-gradient(180deg,${c.base},${c.lo});"></div>` +
      `<div style="position:absolute;left:${x}px;top:${-pop}px;width:${w}px;height:${topH}px;border-radius:12px 12px 0 0;` +
      `background:linear-gradient(150deg,${c.hi},${c.base} 52%,${c.lo});` +
      `box-shadow:inset 0 2px 3px rgba(255,255,255,.22),inset 0 -4px 6px rgba(0,0,0,.34);"></div>` +
      // embossed molded square (the chocolate-bar segment): dark groove + inner
      // sheen — CENTRED at the same footprint (w-6 × topH-8) as the bricks' topping
      // so the wall reads at the same top-down angle, not top-heavy
      `<div style="position:absolute;left:${x + 3}px;top:${-pop + 4}px;width:${w - 6}px;height:${topH - 8}px;border-radius:12px;` +
      `box-shadow:inset 0 0 0 1px rgba(0,0,0,.26),inset 0 2px 2px rgba(255,255,255,.16),inset 0 -3px 4px rgba(0,0,0,.28);"></div>` +
      // tempered sheen streak across the segment top
      `<div style="position:absolute;left:${x + 3}px;top:${-pop + 4}px;width:${w - 6}px;height:7px;border-radius:7px;` +
      `background:linear-gradient(180deg,rgba(255,255,255,.5),transparent);filter:blur(.4px);"></div>`
    );
  }
  // Soft brick = frosted cake (top-down): sponge side + sponge top, a big cream
  // frosting cap CENTRED on the top face (~80% coverage to match the roll cake's
  // swirl footprint — same perspective, so the two brick types sit consistently),
  // dressed with a few colourful chocolate sprinkles (巧克力米).
  return (
    `<div style="position:absolute;left:${x}px;top:${sideTop}px;width:${w}px;height:${sideH}px;` +
    `border-radius:0 0 12px 12px;background:linear-gradient(180deg,#DCBC82,#C7A569);"></div>` +
    `<div style="position:absolute;left:${x}px;top:${-pop}px;width:${w}px;height:${topH}px;border-radius:12px 12px 0 0;` +
    `background:linear-gradient(180deg,#EFD6A6,#DCBC82);"></div>` +
    // big centred cream frosting — same footprint (w-6 × topH-8, centred) as the
    // roll-cake swirl so both brick types read at the same angle
    `<div style="position:absolute;left:${x + 3}px;top:${-pop + 4}px;width:${w - 6}px;height:${topH - 8}px;` +
    `border-radius:14px;background:linear-gradient(180deg,#FFF8EC,#FBE9CD);` +
    `box-shadow:inset 0 2px 2px rgba(255,255,255,.7),inset 0 -3px 5px rgba(214,185,136,.4);"></div>` +
    // colourful sprinkles (彩色巧克力米) spread across the frosting
    sprinkle(12, -pop + 10, 26, '#F2849E') + // strawberry
    sprinkle(28, -pop + 9, -18, '#7FD1B9') + // mint
    sprinkle(18, -pop + 18, 42, '#F5C542') + // lemon
    sprinkle(31, -pop + 22, -34, '#8FA8E8') + // blueberry
    sprinkle(14, -pop + 26, 8, '#5E3A20') // chocolate
  );
}

/** One chocolate-vermicelli dash for the cake topping. */
function sprinkle(left: number, top: number, deg: number, color: string): string {
  return (
    `<div style="position:absolute;left:${left}px;top:${top}px;width:6px;height:2px;border-radius:1px;` +
    `background:${color};transform:rotate(${deg}deg);"></div>`
  );
}

// ---------------------------------------------------------------------------
// Entities (authored inside a TW×TH cell)
// ---------------------------------------------------------------------------

// Soft contact shadow. A radial-gradient ellipse (not filter:blur) so it costs
// no per-frame blur pass when the entity above it moves.
const shadowHtml =
  `<div style="position:absolute;left:${CX - 18}px;top:${TH - 15}px;width:36px;height:15px;` +
  `border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.24),transparent);"></div>`;

/**
 * Bomb = a chocolate truffle cake: milk-choc sponge + a glossy dark-ganache dome
 * with bright sprinkles, breathing via cc-bomb. The lit candle (the fuse) is NOT here — the
 * Renderer adds it as two extra nodes so it can melt DOWN with `fuseTicks` and
 * flicker (see `updateBombs`). Returns only the static, pulsing cake.
 */
export function cakeBombHtml(): string {
  const sponge = `linear-gradient(180deg,${MILK.cakeHi},${MILK.cakeMid} 45%,${MILK.cakeLo})`;
  // Sprinkles: tiny tilted candy sticks on the frosting.
  const sprinkle = (x: number, y: number, deg: number, c: string) =>
    `<div style="position:absolute;left:${x}px;top:${y}px;width:6px;height:3px;border-radius:2px;` +
    `background:${c};transform:rotate(${deg}deg);"></div>`;
  return (
    shadowHtml +
    // One wrapper carries the cc-bomb pulse so sponge+frosting+sprinkles breathe
    // together (the candle, added later, stays put).
    `<div style="position:absolute;inset:0;transform-origin:50% 86%;animation:cc-bomb 1s ease-in-out infinite;">` +
      // Cake side rim — the chocolate cake's thickness; only a thin crescent shows
      // below the top disc, exactly like the bricks' visible side (top-down look)
      `<div style="position:absolute;left:${CX - 18}px;top:${CY}px;width:36px;height:18px;border-radius:50%;` +
      `background:${sponge};box-shadow:inset 0 -2px 3px rgba(0,0,0,.3);"></div>` +
      // Glossy dark-ganache TOP disc — the dominant top face, viewed top-down so it
      // sits at the SAME angle as the top-down frosted bricks (keeps the dark truffle
      // identity that reads apart from the pale bricks)
      `<div style="position:absolute;left:${CX - 18}px;top:${CY - 12}px;width:36px;height:24px;border-radius:50%;` +
      `background:radial-gradient(circle at 42% 34%,${MILK.frostHi},${MILK.frostLo});` +
      `box-shadow:inset 0 3px 4px rgba(255,255,255,.16),inset 0 -4px 6px rgba(0,0,0,.42);"></div>` +
      // cream frosting ring just inside the edge (chocolate-cake-with-cream cue)
      `<div style="position:absolute;left:${CX - 16}px;top:${CY - 10}px;width:32px;height:20px;border-radius:50%;` +
      `box-shadow:inset 0 0 0 1.5px rgba(255,240,214,.4);"></div>` +
      // top gloss highlight
      `<div style="position:absolute;left:${CX - 9}px;top:${CY - 9}px;width:16px;height:6px;border-radius:50%;` +
      `background:rgba(255,255,255,.42);filter:blur(.6px);"></div>` +
      sprinkle(CX - 11, CY - 4, 25, '#F2849E') +
      sprinkle(CX - 1, CY - 6, -20, '#7FC8E8') +
      sprinkle(CX + 8, CY - 2, 40, '#FFD23D') +
    `</div>` +
    // Candle (the fuse) + flame — full height here; the Renderer melts them DOWN
    // as fuseTicks counts down (see setCandleFuse). Outside the pulse wrapper so
    // the candle sinks steadily while the cake just breathes.
    `<div class="cc-candle" style="position:absolute;left:${CX - 2}px;top:1px;width:5px;height:15px;` +
    `border-radius:2px 2px 1px 1px;background:linear-gradient(90deg,${MILK.candle},#fff 50%,${MILK.candle});` +
    `box-shadow:inset -1px 0 1px rgba(150,60,90,.3);"></div>` +
    `<div class="cc-flame-el" style="position:absolute;left:${CX - 3}px;top:-9px;width:7px;height:11px;` +
    `border-radius:50% 50% 45% 45%/65% 65% 35% 35%;transform-origin:50% 100%;` +
    `background:radial-gradient(circle at 50% 70%,#FFF6C8,${MILK.spark} 45%,${MILK.sparkGlow});` +
    `box-shadow:0 0 8px 3px ${MILK.sparkGlow};animation:cc-flame .35s ease-in-out infinite;"></div>`
  );
}

/**
 * Melt the candle to match fuse progress: `frac` = fuseTicks / FUSE_TICKS (1 just
 * placed → 0 about to blow). Candle is bottom-anchored (sits on the frosting) and
 * shrinks from the top; the flame rides the top down. Pure style writes.
 */
export function setCandleFuse(candle: HTMLElement, flame: HTMLElement, frac: number): void {
  const h = Math.max(2, Math.round(15 * Math.max(0, Math.min(1, frac))));
  const top = 16 - h; // bottom fixed at y=16
  candle.style.height = `${h}px`;
  candle.style.top = `${top}px`;
  flame.style.top = `${top - 10}px`;
}

/**
 * Power-up: a glossy candy token whose icon reads its function at a glance,
 * re-themed to baking ingredients. Cream / egg / wings are all PALE and the floor
 * + cake-bricks are pale too, so contrast is built STRUCTURALLY: the disc is the
 * kind's SATURATED colour (not white) + a warm rim + a colour-glow halo → the
 * token lifts off the pale floor, and the pale-white icon pops on the saturated
 * disc (white-on-colour, never pale-on-pale).
 *   FIRE   = whipped-cream swirl (more cream → bigger blast)
 *   CANNON = egg (bake one more cake-bomb)
 *   SPEED  = wings (a legless floater flies faster — no feet needed)
 */
export function itemHtml(kind: number): string {
  const p = ITEM_PAL[kind] ?? ITEM_PAL[ItemKind.FIRE]!;
  const base =
    // colour-glow halo: the primary lift off the pale floor
    `<div style="position:absolute;left:${CX - 22}px;top:${CY - 22}px;width:44px;height:44px;border-radius:50%;` +
    `background:radial-gradient(circle,${p.glow},transparent 64%);"></div>` +
    // SATURATED kind-colour disc (was white) + warm rim so a pale icon sits on
    // colour. Rim + drop-shadow separate the disc edge from the pale floor.
    `<div style="position:absolute;left:${CX - 15}px;top:${CY - 15}px;width:30px;height:30px;border-radius:50%;` +
    `background:radial-gradient(circle at 38% 30%,${p.a},${p.b} 74%);` +
    `box-shadow:0 4px 6px rgba(90,52,24,.3),0 0 0 1.5px rgba(90,52,24,.34),` +
    `inset 0 -3px 4px rgba(90,52,24,.2),inset 0 3px 4px rgba(255,255,255,.6);"></div>`;
  let icon: string;
  if (kind === ItemKind.CANNON) {
    // egg = "bake one more cake-bomb". White ovoid + warm rim pops on caramel.
    icon =
      `<div style="position:absolute;left:${CX - 7}px;top:${CY - 9}px;width:14px;height:18px;` +
      `border-radius:50% 50% 50% 50%/62% 62% 38% 38%;` +
      `background:linear-gradient(157deg,#FFFFFF,#F3E7D0 70%,#E9D8B8);` +
      `box-shadow:0 0 0 1.4px rgba(120,78,40,.5),inset 0 -3px 4px rgba(180,140,90,.28),inset 0 3px 3px rgba(255,255,255,.95);"></div>` +
      `<div style="position:absolute;left:${CX - 4}px;top:${CY - 6}px;width:5px;height:7px;border-radius:50%;` +
      `background:rgba(255,255,255,.85);filter:blur(.4px);"></div>`;
  } else if (kind === ItemKind.SPEED) {
    // wings = an OPENED heart (per request): the heart split into two half-heart
    // wings spread apart with a central gap, each tilted outward from a shared
    // base like wings opening. Teal rim + a feather line each + a teal speed spark
    // in the gap. White-on-mint keeps it off the pale floor.
    const wingRim = `filter:drop-shadow(0 0 .8px rgba(54,140,118,.9)) drop-shadow(0 1px .6px rgba(54,140,118,.4));`;
    icon =
      // left half-heart wing, opened (lobe swings up-left from the base)
      `<div style="position:absolute;left:${CX - 11}px;top:${CY - 8}px;width:11px;height:17px;` +
      `background:linear-gradient(160deg,#FFFFFF,#DBEEE7);transform:rotate(-18deg);transform-origin:100% 96%;` +
      `clip-path:polygon(100% 22%,70% 5%,40% 2%,15% 8%,2% 28%,6% 52%,28% 76%,100% 100%);${wingRim}"></div>` +
      // right half-heart wing, opened (mirror)
      `<div style="position:absolute;left:${CX}px;top:${CY - 8}px;width:11px;height:17px;` +
      `background:linear-gradient(200deg,#FFFFFF,#DBEEE7);transform:rotate(18deg);transform-origin:0% 96%;` +
      `clip-path:polygon(0% 22%,30% 5%,60% 2%,85% 8%,98% 28%,94% 52%,72% 76%,0% 100%);${wingRim}"></div>` +
      // a feather line per wing
      `<div style="position:absolute;left:${CX - 7}px;top:${CY - 1}px;width:5px;height:1.4px;border-radius:1px;background:rgba(54,140,118,.4);transform:rotate(40deg);"></div>` +
      `<div style="position:absolute;left:${CX + 2}px;top:${CY - 1}px;width:5px;height:1.4px;border-radius:1px;background:rgba(54,140,118,.4);transform:rotate(-40deg);"></div>` +
      // teal speed spark in the gap where the wings open from
      `<div style="position:absolute;left:${CX - 2}px;top:${CY + 1}px;width:4px;height:4px;border-radius:50%;` +
      `background:#4FAF94;box-shadow:0 0 5px 1.5px rgba(79,175,148,.85);"></div>`;
  } else {
    // cream in a PIPING BAG, not yet squeezed (ties to the 噗嘰 squeeze sfx). The
    // whole bag is TILTED like it's being held (kills the vertical "!" read):
    // pinched top + cream-filled bag body + plastic sheen. No cream out the nozzle.
    // "more cream → bigger blast"; white-on-pink keeps it off the pale floor.
    icon =
      `<div style="position:absolute;left:${CX - 11}px;top:${CY - 11}px;width:22px;height:24px;` +
      `transform:rotate(24deg);transform-origin:50% 50%;">` +
        // pinched/twisted top
        `<div style="position:absolute;left:6px;top:0px;width:11px;height:5px;border-radius:50%;` +
        `background:linear-gradient(180deg,#FFFFFF,#EAD8BE);box-shadow:0 0 0 1px rgba(150,110,70,.4);"></div>` +
        // bag body: wide top → nozzle, cream-filled "plastic"
        `<div style="position:absolute;left:3px;top:3px;width:16px;height:18px;` +
        `background:linear-gradient(160deg,#FFFFFF,#F6E8D6 62%,#E6D2B4);` +
        `clip-path:polygon(12% 7%,88% 7%,62% 52%,54% 100%,46% 100%,38% 52%);` +
        `filter:drop-shadow(0 0 .8px rgba(150,110,70,.55));"></div>` +
        // plastic sheen
        `<div style="position:absolute;left:8px;top:5px;width:2.4px;height:10px;border-radius:2px;` +
        `background:rgba(255,255,255,.7);filter:blur(.3px);"></div>` +
      `</div>`;
  }
  return base + icon;
}

/**
 * Melt-flow cell, drawn as a DIRECTIONAL stream rather than a per-cell blob so a
 * straight arm fuses into one continuous tube instead of a string of beads.
 * `mask` is the 4-bit set of burning neighbours (1=left 2=right 4=up 8=down): a
 * cream capsule + amber halo is drawn toward each present neighbour, overflowing
 * the cell edge so adjacent runs overlap — crosses, corners and T-junctions form
 * for free. A cell with exactly one neighbour is an arm TIP (or mask 0, a lone
 * cell) and caps its outer end with a squared cream crest (方, not pointed) — the
 * only cell whose shape reads differently. The cross origin adds the white-hot core. All
 * fills are linear/radial/solid (no box-shadow blur on arm cells → cheap on a
 * chain); colours never change with shape.
 */
export function explosionHtml(mask: number): string {
  const L = mask & 1,
    R = mask & 2,
    U = mask & 4,
    D = mask & 8;
  const horiz = L || R;
  const vert = U || D;
  const center = horiz && vert;
  // Shade ACROSS the flow (perpendicular), not per-cell radial → one continuous
  // top-lit ribbon with no repeating per-cell highlight blob.
  const creamH = `linear-gradient(180deg,${MILK.explHi},${MILK.explMid} 45%,${MILK.explLo})`;
  const creamV = `linear-gradient(90deg,${MILK.explHi},${MILK.explMid} 45%,${MILK.explLo})`;
  // Round only OUTER caps (no neighbour on that side); square the inner joins so
  // adjacent cells tile into one seamless tube instead of a string of capsules.
  const r = (a: number, b: number) => `${a}px ${b}px ${b}px ${a}px`; // [left/top, right/bot]
  let h = '';

  // Amber halo "river" along each flowing axis (soft-edged via gradient, no blur)
  // — neighbours' halos overlap into one continuous glowing corridor.
  // Inner ends abut (+1px) rather than overflow, so a semi-transparent neighbour
  // halo doesn't stack into a bright seam line at each join.
  if (horiz) {
    const x0 = L ? -1 : CX - 17,
      x1 = R ? TW + 1 : CX + 17;
    h += `<div style="position:absolute;left:${x0}px;top:${CY - 21}px;width:${x1 - x0}px;height:42px;border-radius:${r(L ? 0 : 21, R ? 0 : 21)};` +
      `background:linear-gradient(180deg,transparent,${MILK.explGlow} 22%,${MILK.explGlow} 78%,transparent);"></div>`;
  }
  if (vert) {
    const y0 = U ? -1 : CY - 17,
      y1 = D ? TH + 1 : CY + 17;
    h += `<div style="position:absolute;left:${CX - 21}px;top:${y0}px;width:42px;height:${y1 - y0}px;border-radius:${r(U ? 0 : 21, D ? 0 : 21)};` +
      `background:linear-gradient(90deg,transparent,${MILK.explGlow} 22%,${MILK.explGlow} 78%,transparent);"></div>`;
  }

  // Cream stream: a fat ribbon toward each neighbour, overflowing ±6px to fuse;
  // inner end square (tiles seamlessly), outer end rounded (clean arm cap).
  if (horiz) {
    const x0 = L ? -6 : CX - 12,
      x1 = R ? TW + 6 : CX + 12;
    h += `<div style="position:absolute;left:${x0}px;top:${CY - 17}px;width:${x1 - x0}px;height:34px;border-radius:${r(L ? 0 : 13, R ? 0 : 13)};background:${creamH};"></div>`;
  }
  if (vert) {
    const y0 = U ? -6 : CY - 12,
      y1 = D ? TH + 6 : CY + 12;
    h += `<div style="position:absolute;left:${CX - 17}px;top:${y0}px;width:34px;height:${y1 - y0}px;border-radius:${r(U ? 0 : 13, D ? 0 : 13)};background:${creamV};"></div>`;
  }

  // Arm tip (one neighbour) or lone cell: the LAST cell = a SQUARED cream crest
  // (方的海浪, not pointed) bulging just past the stream cap — a rounded square the
  // full width of the (now fatter) stream, the cream overflowing the path's end.
  if (mask === 0 || mask === 1 || mask === 2 || mask === 4 || mask === 8) {
    const ox = L ? 1 : R ? -1 : 0; // outward = away from the neighbour
    const oy = U ? 1 : D ? -1 : 0; // (lone cell stays centred → square blob)
    const ex = CX + ox * 15; // crest centre, nudged outward past the cap
    const ey = CY + oy * 15;
    const cream = `linear-gradient(${ox ? '180deg' : '90deg'},${MILK.explHi},${MILK.explMid} 50%,${MILK.explLo})`;
    const cw = ox ? 18 : 36; // short along the flow, full stream-width across it
    const ch = oy ? 18 : 36;
    h += `<div style="position:absolute;left:${ex - 22}px;top:${ey - 22}px;width:44px;height:44px;border-radius:15px;` +
      `background:radial-gradient(closest-side,${MILK.explGlow},transparent 78%);"></div>` +
      `<div style="position:absolute;left:${ex - cw / 2}px;top:${ey - ch / 2}px;width:${cw}px;height:${ch}px;` +
      `border-radius:13px;background:${cream};"></div>` +
      // soft top gloss so the squared crest still reads as cream
      `<div style="position:absolute;left:${ex - 8}px;top:${ey - 9}px;width:14px;height:7px;border-radius:5px;` +
      `background:rgba(255,255,255,.8);filter:blur(.5px);"></div>`;
    // 浪花: white foam flecks flung off the crest's outer edge — sea-spray at the
    // wave head. Outward axis = the flow; spread sideways; farther = smaller/fainter.
    const fux = ox; // outward unit (lone cell → spray upward)
    const fuy = oy || (ox ? 0 : -1);
    const pux = fuy !== 0 ? 1 : 0; // perpendicular axis (sideways spread)
    const puy = fux !== 0 ? 1 : 0;
    const foam: Array<[number, number, number, number]> = [
      // [outward, sideways, size, opacity*100]
      [8, -12, 4, 90], [12, -2, 5, 95], [9, 11, 4, 88],
      [14, 5, 3, 68], [15, -8, 3, 60], [11, -13, 2, 50],
    ];
    for (const [a, p, s, o] of foam)
      h += `<div style="position:absolute;left:${ex + fux * a + pux * p - s / 2}px;` +
        `top:${ey + fuy * a + puy * p - s / 2}px;width:${s}px;height:${s}px;` +
        `border-radius:50%;background:rgba(255,255,255,.${o});"></div>`;
  }

  if (center) {
    // Blast origin = the chocolate cake bursting apart: a molten-ganache core +
    // dark-sponge cake chunks (cream-capped) flung onto the DIAGONALS so they fill
    // the gaps between the orthogonal arms and never sit on the amber kill-zone.
    // Chunk = dark sponge body + cream frosting cap, rotated; crumb = tiny choc dot.
    const chunk = (dx: number, dy: number, d: number, s: number, rot: number) => {
      const x = CX + dx * d,
        y = CY + dy * d;
      return `<div style="position:absolute;left:${x - s / 2}px;top:${y - s / 2}px;width:${s}px;height:${s}px;border-radius:4px;` +
        `background:linear-gradient(160deg,#6B4423,#4A2C16);transform:rotate(${rot}deg);box-shadow:0 1px 2px rgba(0,0,0,.3);">` +
        `<div style="position:absolute;left:0;top:0;width:100%;height:38%;border-radius:4px 4px 2px 2px;background:linear-gradient(180deg,#FBE9C6,#EAD3A2);"></div></div>`;
    };
    const crumb = (dx: number, dy: number, d: number, s: number) =>
      `<div style="position:absolute;left:${CX + dx * d - s / 2}px;top:${CY + dy * d - s / 2}px;width:${s}px;height:${s}px;border-radius:50%;background:#5A3619;"></div>`;
    h +=
      // molten-chocolate core (the cake's melting centre)
      `<div style="position:absolute;left:${CX - 10}px;top:${CY - 10}px;width:20px;height:20px;border-radius:50%;` +
      `background:radial-gradient(circle at 38% 32%,#7A4E29,#4A2C16 70%);box-shadow:0 0 9px 3px rgba(120,64,22,.5);"></div>` +
      `<div style="position:absolute;left:${CX - 4}px;top:${CY - 6}px;width:6px;height:4px;border-radius:50%;background:rgba(255,240,210,.8);filter:blur(.4px);"></div>` +
      // four cake chunks blown out on the diagonals
      chunk(-1, -1, 15, 11, -18) + chunk(1, -1, 16, 10, 22) +
      chunk(-1, 1, 15, 9, 12) + chunk(1, 1, 17, 11, -26) +
      // a few stray crumbs farther out
      crumb(-1, -1, 23, 3) + crumb(1, 1, 24, 3) + crumb(1, -1, 22, 2);
  }
  return h;
}

/**
 * Player mascot: chef-hat cutie, or a steel robot-chef when `isBot`. The face
 * (eyes/cheeks/mouth, or the robot visor/LED/grille) shifts toward the facing
 * direction (dx/dy ∈ {-1,0,1}) for down/left/right. Facing UP means facing
 * away from the camera, so the face is hidden and the back of the head shows
 * (a plain hatted nape / a brushed-steel vent panel). Reads at a glance.
 */
export function playerHtml(team: number, isBot: boolean, dx = 0, dy = 0): string {
  const col = teamPalette(team);
  const fx = dx * 5; // cutie face horizontal shift
  const fy = dy * 4; // cutie face vertical shift
  const vx = dx * 5; // robot visor horizontal shift
  const vy = dy * 3; // robot visor vertical shift
  const facingUp = dy < 0; // facing away from camera → show the back of the head
  if (isBot) {
    // Front face (visor + LED + grille), shifted toward the facing direction.
    const front =
      `<div style="position:absolute;left:${CX - 14 + vx}px;top:${-1 + vy}px;width:28px;height:13px;border-radius:7px;` +
      `background:linear-gradient(180deg,#222831,#3C4651 70%,#525E6B);` +
      `box-shadow:inset 0 1px 2px rgba(0,0,0,.6),inset 0 -1px 1px rgba(255,255,255,.18),0 1px 1px rgba(255,255,255,.35);"></div>` +
      `<div style="position:absolute;left:${CX - 10 + vx}px;top:${3 + vy}px;width:20px;height:5px;border-radius:3px;` +
      `background:linear-gradient(90deg,${col.base},${col.hi} 50%,${col.base});box-shadow:0 0 9px 1px ${col.base};"></div>` +
      `<div style="position:absolute;left:${CX - 6 + vx}px;top:15px;width:12px;height:5px;border-radius:2px;` +
      `background:repeating-linear-gradient(90deg,#2C333C 0 1.4px,#7E8A96 1.4px 2.8px);"></div>`;
    // Back of the head when facing up: a brushed-steel panel with cooling vents.
    const back =
      `<div style="position:absolute;left:${CX - 11}px;top:0px;width:22px;height:13px;border-radius:6px;` +
      `background:linear-gradient(180deg,#D6DCE3,#9BA5B0);box-shadow:inset 0 1px 1px rgba(255,255,255,.75),inset 0 -2px 3px rgba(0,0,0,.22);"></div>` +
      `<div style="position:absolute;left:${CX - 7}px;top:3px;width:14px;height:2px;border-radius:1px;background:rgba(0,0,0,.24);"></div>` +
      `<div style="position:absolute;left:${CX - 7}px;top:7px;width:14px;height:2px;border-radius:1px;background:rgba(0,0,0,.24);"></div>`;
    return (
      shadowHtml +
      `<div style="position:absolute;left:${CX - 17}px;top:-13px;width:34px;height:40px;` +
      `border-radius:48% 48% 45% 45%/54% 54% 44% 44%;background:linear-gradient(168deg,#F1F4F8,#AEB8C2 56%,#7C8893);` +
      `box-shadow:0 8px 11px rgba(0,0,0,.3),inset 0 -5px 7px rgba(0,0,0,.2),inset 0 5px 7px rgba(255,255,255,.65);"></div>` +
      `<div style="position:absolute;left:${CX - 14}px;top:-15px;width:28px;height:8px;border-radius:6px;` +
      `background:linear-gradient(180deg,#C9D0D8,#929BA6);box-shadow:0 2px 3px rgba(0,0,0,.2),inset 0 1px 1px rgba(255,255,255,.95);"></div>` +
      `<div style="position:absolute;left:${CX - 16}px;top:-30px;width:32px;height:21px;` +
      `border-radius:52% 52% 30% 30%/72% 72% 36% 36%;background:radial-gradient(circle at 38% 30%,#FFFFFF,#DFE4EA);` +
      `box-shadow:inset 0 3px 5px rgba(255,255,255,.92),inset 0 -3px 4px rgba(0,0,0,.1),0 3px 4px rgba(0,0,0,.16);"></div>` +
      `<div style="position:absolute;left:${CX - 1}px;top:-44px;width:3px;height:15px;border-radius:2px;` +
      `background:linear-gradient(180deg,#C7CED6,#8A95A1);"></div>` +
      `<div style="position:absolute;left:${CX - 6}px;top:-51px;width:12px;height:12px;border-radius:50%;` +
      `background:radial-gradient(circle at 35% 30%,#FFFFFF,${col.base});box-shadow:0 0 11px 3px ${col.base};"></div>` +
      `<div style="position:absolute;left:${CX - 19}px;top:1px;width:8px;height:8px;border-radius:50%;` +
      `background:radial-gradient(circle at 38% 32%,#F1F4F8,#8D98A4);box-shadow:inset 0 0 0 1.5px rgba(0,0,0,.18),0 1px 1px rgba(0,0,0,.2);"></div>` +
      `<div style="position:absolute;left:${CX + 11}px;top:1px;width:8px;height:8px;border-radius:50%;` +
      `background:radial-gradient(circle at 38% 32%,#F1F4F8,#8D98A4);box-shadow:inset 0 0 0 1.5px rgba(0,0,0,.18),0 1px 1px rgba(0,0,0,.2);"></div>` +
      (facingUp ? back : front)
    );
  }
  // Front face, shifted toward the facing direction.
  const front =
    `<div style="position:absolute;left:${CX - 8 + fx}px;top:${0 + fy}px;width:5px;height:8px;border-radius:50%;background:${MILK.eye};"></div>` +
    `<div style="position:absolute;left:${CX + 3 + fx}px;top:${0 + fy}px;width:5px;height:8px;border-radius:50%;background:${MILK.eye};"></div>` +
    `<div style="position:absolute;left:${CX - 13 + fx}px;top:${6 + fy}px;width:8px;height:4px;border-radius:50%;background:${MILK.cheek};"></div>` +
    `<div style="position:absolute;left:${CX + 5 + fx}px;top:${6 + fy}px;width:8px;height:4px;border-radius:50%;background:${MILK.cheek};"></div>` +
    `<div style="position:absolute;left:${CX - 3 + fx}px;top:${7 + fy}px;width:7px;height:4px;border-radius:0 0 9px 9px;background:${col.lo};"></div>`;
  // Back of the head when facing up: no face, just a centre seam + nape shadow.
  const back =
    `<div style="position:absolute;left:${CX - 1}px;top:0px;width:2px;height:12px;border-radius:1px;background:rgba(0,0,0,.08);"></div>` +
    `<div style="position:absolute;left:${CX - 9}px;top:8px;width:18px;height:5px;border-radius:50%;background:rgba(0,0,0,.07);filter:blur(1px);"></div>`;
  return (
    shadowHtml +
    `<div style="position:absolute;left:${CX - 17}px;top:-13px;width:34px;height:40px;` +
    `border-radius:48% 48% 45% 45%/54% 54% 44% 44%;background:linear-gradient(168deg,${col.hi},${col.base} 56%,${col.lo});` +
    `box-shadow:0 8px 11px rgba(0,0,0,.25),inset 0 -5px 7px rgba(0,0,0,.14),inset 0 5px 7px rgba(255,255,255,.45);"></div>` +
    `<div style="position:absolute;left:${CX - 14}px;top:-15px;width:28px;height:8px;border-radius:6px;` +
    `background:linear-gradient(180deg,#FFFFFF,#EFE7D8);box-shadow:0 2px 3px rgba(0,0,0,.14),inset 0 1px 1px rgba(255,255,255,.9);"></div>` +
    `<div style="position:absolute;left:${CX - 16}px;top:-30px;width:32px;height:21px;` +
    `border-radius:52% 52% 30% 30%/72% 72% 36% 36%;background:radial-gradient(circle at 38% 30%,#FFFFFF,#EFE7D8);` +
    `box-shadow:inset 0 3px 5px rgba(255,255,255,.92),inset 0 -3px 4px rgba(0,0,0,.07),0 3px 4px rgba(0,0,0,.12);"></div>` +
    (facingUp ? back : front)
  );
}

/** Sugar-shell dome over a sealed cutie (trapped player). */
export function shellHtml(): string {
  return (
    shadowHtml +
    `<div style="position:absolute;left:${CX - 15}px;top:-6px;width:30px;height:34px;` +
    `border-radius:48% 48% 45% 45%/54% 54% 44% 44%;background:${SHELL.body};box-shadow:inset 0 -4px 6px rgba(0,0,0,.16);"></div>` +
    `<div style="position:absolute;left:${CX - 7}px;top:4px;width:5px;height:5px;border-radius:50%;background:${SHELL.eye};"></div>` +
    `<div style="position:absolute;left:${CX + 2}px;top:4px;width:5px;height:5px;border-radius:50%;background:${SHELL.eye};"></div>` +
    `<div style="position:absolute;left:${CX - 22}px;top:-13px;width:44px;height:48px;` +
    `border-radius:50% 50% 47% 47%/55% 55% 45% 45%;background:${SHELL.shell};border:2px solid rgba(120,70,38,.6);` +
    `box-shadow:inset 0 -8px 13px rgba(40,22,10,.5),inset 0 8px 13px rgba(255,255,255,.5),0 6px 11px rgba(0,0,0,.16);"></div>` +
    `<div style="position:absolute;left:${CX - 11}px;top:-8px;width:12px;height:19px;border-radius:50%;` +
    `background:rgba(255,255,255,.7);transform:rotate(20deg);filter:blur(.5px);"></div>` +
    `<div style="position:absolute;left:${CX + 7}px;top:-10px;width:6px;height:6px;border-radius:1px;` +
    `background:#fff;transform:rotate(45deg);box-shadow:0 0 7px 2px rgba(255,255,255,.9);"></div>`
  );
}

/** Keyframes used by bomb fuse / sudden-death pill — injected once by Renderer. */
export const CANDY_KEYFRAMES = `
@keyframes cc-bomb{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
@keyframes cc-spark{0%,100%{opacity:.7;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
@keyframes cc-flame{0%,100%{transform:scaleY(1) translateX(0);opacity:.95}50%{transform:scaleY(1.18) translateX(.6px);opacity:1}}
@keyframes cc-danger{0%,100%{box-shadow:0 8px 18px rgba(74,42,24,.4),0 0 0 0 rgba(255,80,60,.5)}50%{box-shadow:0 8px 18px rgba(74,42,24,.4),0 0 22px 6px rgba(255,80,60,.6)}}
`;
