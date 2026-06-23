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
export const PAD_TOP = 24;
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
  wall: { hi: '#8C5C36', base: '#5E3A20', lo: '#341F0E' },
  block: { hi: '#FFF7E8', base: '#F2DFBC', lo: '#D6B988' },
  // Near-black glossy truffle — distinct from the mid-brown matte wall cubes.
  bombHi: '#4a2a1a',
  bombMid: '#220f06',
  bombLo: '#080302',
  spark: '#FFE3A1',
  sparkGlow: '#FF9B3D',
  // Cream melt-flow (奶油流): whipped-white stream over a saturated amber halo
  // (the "火力"); the halo is far more orange than the tan floor, so the flow
  // reads even though both cream and floor are pale. explShadow lifts it off.
  explGlow: 'rgba(255,124,30,.62)',
  explHi: '#FFFFFF',
  explMid: '#FFF1D6',
  explLo: '#FBD99E',
  explCore: '#FFE6B4',
  explShadow: 'rgba(120,64,22,.42)',
  eye: '#3A2A22',
  cheek: 'rgba(244,120,150,.55)',
} as const;

// Whipped-meringue dome trapping a caught cutie (design SHELL).
const SHELL = {
  body: 'linear-gradient(168deg,#FBE9C6,#EDD09A 56%,#D4B179)',
  eye: '#7A5A34',
  shell:
    'radial-gradient(circle at 34% 26%, rgba(255,255,255,.95), rgba(255,250,236,.42) 44%, rgba(250,228,182,.4) 70%, rgba(240,210,150,.5))',
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
export function cubeHtml(kind: 'wall' | 'block'): string {
  const pop = kind === 'wall' ? POP_WALL : POP_BLOCK;
  const x = 2;
  const w = TW - 4;
  const topH = TH - 4; // flat top surface
  const sideTop = -pop + topH; // flush with the top face's (square) bottom edge
  const sideH = pop + 6; // down to the cell bottom (+ slight overflow to overlap)
  if (kind === 'wall') {
    // One rounded silhouette: top rounds only its TOP corners, side only its
    // BOTTOM — same x/width so they fuse; gradients meet at `base` (smooth seam,
    // side darkens to `lo` = the thickness). No blurred cast shadow.
    const c = MILK.wall;
    return (
      `<div style="position:absolute;left:${x}px;top:${sideTop}px;width:${w}px;height:${sideH}px;` +
      `border-radius:0 0 12px 12px;background:linear-gradient(180deg,${c.base},${c.lo});"></div>` +
      `<div style="position:absolute;left:${x}px;top:${-pop}px;width:${w}px;height:${topH}px;border-radius:12px 12px 0 0;` +
      `background:linear-gradient(160deg,${c.hi},${c.base});` +
      `box-shadow:inset 0 3px 4px rgba(255,255,255,.16);"></div>` +
      `<div style="position:absolute;left:9px;top:${-pop + 5}px;width:${TW - 28}px;height:8px;border-radius:8px;` +
      `background:radial-gradient(closest-side,rgba(255,255,255,.42),transparent);"></div>`
    );
  }
  // Soft brick = layered cake: sponge side + raised sponge top, a cream filling
  // band through the middle (奶油/海綿 layering), a cream frosting cap, and a few
  // chocolate sprinkles (巧克力米) scattered on top.
  return (
    `<div style="position:absolute;left:${x}px;top:${sideTop}px;width:${w}px;height:${sideH}px;` +
    `border-radius:0 0 12px 12px;background:linear-gradient(180deg,#DCBC82,#C7A569);"></div>` +
    `<div style="position:absolute;left:${x}px;top:${-pop}px;width:${w}px;height:${topH}px;border-radius:12px 12px 0 0;` +
    `background:linear-gradient(180deg,#EFD6A6,#DCBC82);"></div>` +
    // cream filling band through the middle → a visible cream/sponge layer
    `<div style="position:absolute;left:${x}px;top:${-pop + 19}px;width:${w}px;height:6px;` +
    `background:linear-gradient(180deg,#FFF3DC,#F0DBB4);box-shadow:0 1px 0 rgba(150,108,58,.18);"></div>` +
    // frosting cap
    `<div style="position:absolute;left:${x}px;top:${-pop}px;width:${w}px;height:17px;border-radius:12px 12px 9px 9px;` +
    `background:linear-gradient(180deg,#FFF8EC,#FBE9CD);box-shadow:inset 0 2px 2px rgba(255,255,255,.7);"></div>` +
    // colourful sprinkles (彩色巧克力米) on the frosting
    sprinkle(8, -pop + 1, 26, '#F2849E') + // strawberry
    sprinkle(19, -pop + 5, -18, '#7FD1B9') + // mint
    sprinkle(29, -pop + 1, 42, '#F5C542') + // lemon
    sprinkle(34, -pop + 7, -34, '#8FA8E8') + // blueberry
    sprinkle(15, -pop + 8, 8, '#5E3A20') // chocolate
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

/** Truffle bomb with a glowing fuse spark (pulse via cc-bomb keyframe). */
export function bombHtml(): string {
  return (
    shadowHtml +
    `<div style="position:absolute;left:${CX - 18}px;top:${CY - 21}px;width:36px;height:36px;border-radius:50%;` +
    `background:radial-gradient(circle at 34% 28%,${MILK.bombHi},${MILK.bombMid} 46%,${MILK.bombLo});` +
    `box-shadow:0 7px 10px rgba(0,0,0,.3),inset 0 -3px 5px rgba(0,0,0,.4);animation:cc-bomb 1s ease-in-out infinite;"></div>` +
    `<div style="position:absolute;left:${CX - 7}px;top:${CY - 17}px;width:12px;height:8px;border-radius:50%;` +
    `background:rgba(255,255,255,.6);filter:blur(1px);"></div>` +
    `<div style="position:absolute;left:${CX + 7}px;top:${CY - 28}px;width:9px;height:9px;border-radius:50%;` +
    `background:${MILK.spark};box-shadow:0 0 12px 4px ${MILK.sparkGlow};animation:cc-spark 1.2s ease-in-out infinite;"></div>`
  );
}

/**
 * Power-up: a glossy candy pill (kind-tinted glow) carrying a bold icon that
 * reads its function at a glance — FIRE = flame (bigger blast), SPEED = lightning
 * (faster), CANNON = mini bomb (more bombs).
 */
export function itemHtml(kind: number): string {
  const p = ITEM_PAL[kind] ?? ITEM_PAL[ItemKind.FIRE]!;
  const base =
    `<div style="position:absolute;left:${CX - 22}px;top:${CY - 22}px;width:44px;height:44px;border-radius:50%;` +
    `background:radial-gradient(circle,${p.glow},transparent 66%);"></div>` +
    `<div style="position:absolute;left:${CX - 15}px;top:${CY - 15}px;width:30px;height:30px;border-radius:50%;` +
    `background:radial-gradient(circle at 38% 30%,#FFFFFF,#FCEFD8);` +
    `box-shadow:0 4px 6px rgba(90,52,24,.22),inset 0 -3px 4px rgba(120,80,40,.14),inset 0 3px 4px rgba(255,255,255,.85);"></div>`;
  let icon: string;
  if (kind === ItemKind.CANNON) {
    // mini truffle bomb = "more bombs"
    icon =
      `<div style="position:absolute;left:${CX - 8}px;top:${CY - 7}px;width:16px;height:16px;border-radius:50%;` +
      `background:radial-gradient(circle at 36% 30%,#5a3a2a,#220f06 60%,#080302);box-shadow:inset 0 -1px 2px rgba(0,0,0,.5);"></div>` +
      `<div style="position:absolute;left:${CX + 4}px;top:${CY - 11}px;width:4px;height:4px;border-radius:50%;` +
      `background:${MILK.spark};box-shadow:0 0 6px 2px ${MILK.sparkGlow};"></div>`;
  } else if (kind === ItemKind.SPEED) {
    // lightning bolt = "faster"
    icon =
      `<div style="position:absolute;left:${CX - 8}px;top:${CY - 10}px;width:16px;height:19px;` +
      `background:linear-gradient(160deg,#FFE07A,#F5A623);filter:drop-shadow(0 1px 1px rgba(150,90,20,.4));` +
      `clip-path:polygon(58% 0,24% 56%,48% 56%,40% 100%,80% 40%,54% 40%,74% 0);"></div>`;
  } else {
    // flame = "bigger blast" (FIRE)
    icon =
      `<div style="position:absolute;left:${CX - 8}px;top:${CY - 10}px;width:16px;height:19px;` +
      `background:linear-gradient(180deg,#FFD23D,#FF7A2D 55%,#E83A2E);` +
      `clip-path:polygon(50% 0,68% 28%,60% 44%,78% 64%,64% 100%,36% 100%,22% 64%,40% 44%,32% 28%);"></div>` +
      `<div style="position:absolute;left:${CX - 3}px;top:${CY}px;width:6px;height:9px;` +
      `background:linear-gradient(180deg,#FFF2B0,#FFB04D);clip-path:polygon(50% 0,80% 55%,50% 100%,20% 55%);"></div>`;
  }
  return base + icon;
}

/**
 * Melt-flow cell. The cream body and amber halo are BOTH oversized (overflow the
 * cell), so adjacent burning cells overlap into one continuous cream stream with
 * a fused glowing corridor — no goo-filter needed. All fills are radial/solid
 * (no box-shadow blur on the many arm cells) to stay cheap on a chain. `center`
 * adds the white-hot core + droplets.
 */
export function explosionHtml(center: boolean): string {
  let h =
    // Amber halo — the "火力". Wide enough that neighbours' halos merge into a
    // glowing river and lift the pale cream off the pale floor.
    `<div style="position:absolute;left:${CX - 38}px;top:${CY - 35}px;width:76px;height:70px;border-radius:50%;` +
    `background:radial-gradient(circle,${MILK.explGlow},transparent 72%);"></div>` +
    // Soft contact shadow under the cream → reads as a raised flow, not floor.
    `<div style="position:absolute;left:${CX - 28}px;top:${CY - 18}px;width:56px;height:52px;border-radius:50%;` +
    `background:radial-gradient(closest-side,${MILK.explShadow},transparent);"></div>` +
    // Flowing cream body — oversized (56×52 in a 48×44 cell) so runs merge.
    `<div style="position:absolute;left:${CX - 28}px;top:${CY - 26}px;width:56px;height:52px;` +
    `border-radius:52% 48% 50% 50%/54% 50% 50% 46%;` +
    `background:radial-gradient(circle at 42% 34%,${MILK.explHi},${MILK.explMid} 50%,${MILK.explLo});"></div>`;
  if (center) {
    // Only one centre cell per blast → a little extra detail here is affordable.
    h +=
      `<div style="position:absolute;left:${CX - 16}px;top:${CY - 14}px;width:32px;height:28px;border-radius:50%;` +
      `background:radial-gradient(circle,#fff,${MILK.explCore} 72%);box-shadow:0 0 14px 4px ${MILK.explGlow};"></div>` +
      `<div style="position:absolute;left:${CX - 30}px;top:${CY - 22}px;width:11px;height:11px;border-radius:50%;background:${MILK.explLo};"></div>` +
      `<div style="position:absolute;left:${CX + 21}px;top:${CY - 18}px;width:9px;height:9px;border-radius:50%;background:${MILK.explHi};"></div>` +
      `<div style="position:absolute;left:${CX - 26}px;top:${CY + 15}px;width:8px;height:8px;border-radius:50%;background:${MILK.explMid};"></div>` +
      `<div style="position:absolute;left:${CX + 24}px;top:${CY + 13}px;width:10px;height:10px;border-radius:50%;background:${MILK.explLo};"></div>`;
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
    `border-radius:50% 50% 47% 47%/55% 55% 45% 45%;background:${SHELL.shell};border:2px solid rgba(255,255,255,.78);` +
    `box-shadow:inset 0 -8px 13px rgba(214,170,110,.4),inset 0 8px 13px rgba(255,255,255,.8),0 6px 11px rgba(0,0,0,.16);"></div>` +
    `<div style="position:absolute;left:${CX - 11}px;top:-8px;width:12px;height:19px;border-radius:50%;` +
    `background:rgba(255,255,255,.85);transform:rotate(20deg);filter:blur(.5px);"></div>` +
    `<div style="position:absolute;left:${CX + 7}px;top:-10px;width:6px;height:6px;border-radius:1px;` +
    `background:#fff;transform:rotate(45deg);box-shadow:0 0 7px 2px rgba(255,255,255,.9);"></div>`
  );
}

/** Keyframes used by bomb fuse / sudden-death pill — injected once by Renderer. */
export const CANDY_KEYFRAMES = `
@keyframes cc-bomb{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
@keyframes cc-spark{0%,100%{opacity:.7;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
@keyframes cc-danger{0%,100%{box-shadow:0 8px 18px rgba(74,42,24,.4),0 0 0 0 rgba(255,80,60,.5)}50%{box-shadow:0 8px 18px rgba(74,42,24,.4),0 0 22px 6px rgba(255,80,60,.6)}}
`;
