/**
 * DOM renderer — draws the match in the "milk-cream" candy style ported from
 * the IsoArena / CocoaClash design comps (see candyArt.ts).
 *
 * Why DOM, not Pixi: the design is authored entirely in CSS (gradients, inset
 * shadows, glows, border-radius). Reproducing that faithfully is a verbatim CSS
 * port to <div>s — far less code and far higher fidelity than re-deriving every
 * gradient/shadow in Graphics. The render layer is non-deterministic and fully
 * decoupled from the sim, so the medium is free to change.
 *
 * Layout: a board (radial-cream bg) with stacked entity layers, a floating
 * truffle timer pill, and a candy HUD strip below. Public surface is unchanged
 * from the old Pixi renderer (create / canvas / setHudHint / setSlotLabels /
 * render), so solo, spectate and net keep working untouched.
 *
 * Layer z-order (bottom→top): tiles · items · bombs · players · explosions ·
 * shells — matching the old stack (flames cover players, shells cover flames).
 */
import {
  MAP_COLS,
  MAP_ROWS,
  MATCH_MAX_TICKS,
  MILLITILE,
  SUDDEN_DEATH_START_TICK,
  TICK_HZ,
} from '../../../shared/constants';
import { GamePhase, TileKind } from '../../../shared/types';
import { idx } from '../sim/Map';
import { resolveOutcome } from '../sim/Outcome';
import { dirDX, dirDY, type PlayerState } from '../sim/Player';
import type { SimState } from '../sim/Sim';
import {
  boardCss,
  boardSize,
  bombHtml,
  CANDY_KEYFRAMES,
  cellLeft,
  cellTop,
  cubeHtml,
  explosionHtml,
  floorHtml,
  itemHtml,
  PAD_TOP,
  PAD_X,
  playerHtml,
  shellHtml,
  teamPalette,
  TH,
  TW,
} from './candyArt';
import { lerp, SNAP_THRESHOLD_MT } from './interpolate';

/** Default controls hint (the local hotseat / solo mode). */
export const HOTSEAT_HINT = '方向鍵移動 · 空白鍵放巧克力 · R 重新開始';

// Painter z-index = row*10 + type rank, so a front-row (larger y) cube paints
// over an entity in the row behind it. Within a row: floor/cube < item < bomb <
// player < explosion < shell.
const Z = { TILE: 0, ITEM: 1, BOMB: 2, PLAYER: 3, EXPL: 4, SHELL: 5 } as const;
const rowZ = (row: number, rank: number): string => String(row * 10 + rank);

function div(css: string, parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  parent?.appendChild(d);
  return d;
}

/** Fractional tile (x,y) of an entity, lerped prev→next with the snap rule. */
function tileFrac(
  prev: PlayerState | undefined,
  next: PlayerState,
  alpha: number,
): { tx: number; ty: number } {
  let mx = next.posX;
  let my = next.posY;
  if (
    prev !== undefined &&
    Math.abs(next.posX - prev.posX) <= SNAP_THRESHOLD_MT &&
    Math.abs(next.posY - prev.posY) <= SNAP_THRESHOLD_MT
  ) {
    mx = lerp(prev.posX, next.posX, alpha);
    my = lerp(prev.posY, next.posY, alpha);
  }
  return { tx: mx / MILLITILE, ty: my / MILLITILE };
}

export class Renderer {
  private readonly root: HTMLDivElement;
  private readonly tileLayer: HTMLDivElement;
  private readonly itemLayer: HTMLDivElement;
  private readonly bombLayer: HTMLDivElement;
  private readonly playerLayer: HTMLDivElement;
  private readonly explLayer: HTMLDivElement;
  private readonly shellLayer: HTMLDivElement;
  private readonly timer: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly cards: HTMLDivElement;

  private readonly itemPool = new Map<string, HTMLDivElement>();
  private readonly bombPool = new Map<string, HTMLDivElement>();
  private readonly explPool = new Map<
    string,
    { node: HTMLDivElement; center: boolean; op: string }
  >();
  private readonly playerPool = new Map<number, { node: HTMLDivElement; sig: string; z: string }>();
  private readonly shellPool = new Map<
    number,
    { node: HTMLDivElement; num: HTMLDivElement; z: string }
  >();
  private readonly cardPool = new Map<number, CardView>();
  private readonly tileNodes: HTMLDivElement[] = [];

  private lastMap: Uint8Array | null = null;
  private restartHint = true;
  private slotLabels: ReadonlyArray<string | undefined> = [];
  private botSlots: ReadonlySet<number> | null = null;
  // HUD dirty-check: only touch the DOM when the displayed value actually changes.
  private lastTimer = '';
  private lastBanner = '';

  private constructor(hintText: string) {
    const { w, h } = boardSize(MAP_COLS, MAP_ROWS);

    this.root = div(
      "display:inline-flex;flex-direction:column;align-items:stretch;" +
        "font-family:'Nunito',sans-serif;-webkit-font-smoothing:antialiased;",
    );
    const style = document.createElement('style');
    style.textContent = CANDY_KEYFRAMES;
    this.root.appendChild(style);

    // Board ------------------------------------------------------------------
    const board = div(
      boardCss(MAP_COLS, MAP_ROWS) +
        'border-radius:22px;box-shadow:0 22px 54px rgba(80,50,25,.2);',
      this.root,
    );
    // One stacking context: every tile/entity is a direct child of the board and
    // ordered by a per-row z-index (see Z_* / rowZ), so a raised cube in a front
    // row correctly occludes an entity standing in the row behind it. Separate
    // full-board layers would force all entities above all tiles and break that.
    this.tileLayer =
      this.itemLayer =
      this.bombLayer =
      this.playerLayer =
      this.explLayer =
      this.shellLayer =
        board;

    // Floating truffle timer pill (design signature), top-centre over the board.
    this.timer = div(
      `position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:1000;` +
        `display:none;align-items:center;justify-content:center;height:48px;padding:0 26px;` +
        `background:linear-gradient(180deg,#6B4326,#4A2A18);border-radius:999px;` +
        `box-shadow:0 8px 18px rgba(74,42,24,.4),inset 0 2px 0 rgba(255,255,255,.12);` +
        `font-family:'Baloo 2','Nunito',sans-serif;font-weight:800;font-size:26px;` +
        `letter-spacing:.04em;color:#FBE9CF;white-space:nowrap;`,
      board,
    );

    // HUD strip --------------------------------------------------------------
    const hud = div(
      `width:${w}px;margin-top:14px;padding:14px 18px;border-radius:18px;` +
        `background:linear-gradient(160deg,#FFF8EE,#F7E6CC);box-shadow:0 8px 0 #EFE0CA;` +
        `display:flex;flex-direction:column;gap:10px;`,
      this.root,
    );
    this.banner = div(
      "font-family:'Baloo 2','Nunito',sans-serif;font-weight:800;font-size:18px;color:#5A3420;",
      hud,
    );
    this.hint = div('font-weight:700;font-size:13px;color:#A07C56;', hud);
    this.hint.textContent = hintText;
    this.cards = div('display:flex;flex-wrap:wrap;gap:10px;', hud);

    void h;
  }

  static create(): Promise<Renderer> {
    return Promise.resolve(new Renderer(HOTSEAT_HINT));
  }

  /** Root element to mount (named `canvas` to match the old Pixi surface). */
  get canvas(): HTMLElement {
    return this.root;
  }

  setHudHint(text: string, restartHint: boolean = true): void {
    this.hint.textContent = text;
    this.restartHint = restartHint;
  }

  setSlotLabels(labels: ReadonlyArray<string | undefined>): void {
    this.slotLabels = labels;
  }

  /**
   * Which slots render as robot-chefs vs chef-hat cuties. Unset (null) defaults
   * to "slot 0 is the human, the rest are bots" — correct for solo. Spectate
   * passes all slots; net passes none.
   */
  setBotSlots(slots: ReadonlySet<number>): void {
    this.botSlots = slots;
  }

  private isBot(slot: number): boolean {
    return this.botSlots ? this.botSlots.has(slot) : slot !== 0;
  }

  render(prev: SimState, next: SimState, alpha: number): void {
    this.updateTiles(next);
    this.updateItems(next);
    this.updateBombs(next);
    this.updatePlayers(prev, next, alpha);
    this.updateExplosions(next);
    this.updateShells(prev, next, alpha);
    this.updateHud(next);
  }

  // -- Tiles (built once; afterwards only changed cells re-render) ------------
  private updateTiles(next: SimState): void {
    const map = next.map;
    if (this.lastMap === null) {
      this.lastMap = new Uint8Array(map);
      for (let y = 0; y < MAP_ROWS; y++) {
        for (let x = 0; x < MAP_COLS; x++) {
          const node = div(
            `position:absolute;left:${cellLeft(x)}px;top:${cellTop(y)}px;` +
              `width:${TW}px;height:${TH}px;z-index:${rowZ(y, Z.TILE)};`,
          );
          node.innerHTML = tileInner(map[idx(x, y)] ?? TileKind.EMPTY, x, y);
          this.tileLayer.appendChild(node);
          this.tileNodes[idx(x, y)] = node;
        }
      }
      return;
    }
    // A destroyed brick / a hardened sudden-death tile touches a handful of
    // cells per tick — re-render only those, never the whole 195-cell layer
    // (rebuilding the heavy composited layer was the brick-destruction hitch).
    for (let i = 0; i < map.length; i++) {
      if (map[i] === this.lastMap[i]) continue;
      this.lastMap[i] = map[i]!;
      const node = this.tileNodes[i];
      if (node === undefined) continue;
      node.innerHTML = tileInner(map[i] ?? TileKind.EMPTY, i % MAP_COLS, (i / MAP_COLS) | 0);
    }
  }

  // -- Items (tile-locked; hidden while the tile is burning) ------------------
  private updateItems(next: SimState): void {
    const burning = new Set<string>();
    for (const c of next.explosions) burning.add(`${c.tileX},${c.tileY}`);

    const seen = new Set<string>();
    for (const it of next.items) {
      if (burning.has(`${it.tileX},${it.tileY}`)) continue;
      const key = `${it.tileX},${it.tileY},${it.kind}`;
      seen.add(key);
      let node = this.itemPool.get(key);
      if (node === undefined) {
        node = div(
          `position:absolute;left:${cellLeft(it.tileX)}px;top:${cellTop(it.tileY)}px;` +
            `width:${TW}px;height:${TH}px;z-index:${rowZ(it.tileY, Z.ITEM)};`,
        );
        node.innerHTML = itemHtml(it.kind);
        this.itemLayer.appendChild(node);
        this.itemPool.set(key, node);
      }
      node.style.display = 'block';
    }
    for (const [key, node] of this.itemPool) {
      if (!seen.has(key)) node.style.display = 'none';
    }
  }

  // -- Bombs (tile-locked) ---------------------------------------------------
  private updateBombs(next: SimState): void {
    const seen = new Set<string>();
    for (const b of next.bombs) {
      const key = `${b.tileX},${b.tileY}`;
      seen.add(key);
      let node = this.bombPool.get(key);
      if (node === undefined) {
        node = div(
          `position:absolute;left:${cellLeft(b.tileX)}px;top:${cellTop(b.tileY)}px;` +
            `width:${TW}px;height:${TH}px;will-change:transform;z-index:${rowZ(b.tileY, Z.BOMB)};`,
        );
        node.innerHTML = bombHtml();
        this.bombLayer.appendChild(node);
        this.bombPool.set(key, node);
      }
      node.style.display = 'block';
    }
    for (const [key, node] of this.bombPool) {
      if (!seen.has(key)) node.style.display = 'none';
    }
  }

  // -- Players (continuous; trapped ones move to the shell layer) ------------
  private updatePlayers(prev: SimState, next: SimState, alpha: number): void {
    const seen = new Set<number>();
    for (const pl of next.players) {
      if (!pl.alive || pl.trapped) continue;
      seen.add(pl.slot);
      const sig = `${pl.team}:${this.isBot(pl.slot) ? 'b' : 'c'}:${pl.facing}`;
      let v = this.playerPool.get(pl.slot);
      if (v === undefined) {
        const node = div(
          `position:absolute;left:0;top:0;width:${TW}px;height:${TH}px;will-change:transform;`,
        );
        this.playerLayer.appendChild(node);
        v = { node, sig: '', z: '' };
        this.playerPool.set(pl.slot, v);
      }
      if (v.sig !== sig) {
        v.node.innerHTML = playerHtml(
          pl.team,
          this.isBot(pl.slot),
          dirDX(pl.facing),
          dirDY(pl.facing),
        );
        v.sig = sig;
      }
      const prevPl = prev.players.find((p) => p.slot === pl.slot);
      const { tx, ty } = tileFrac(prevPl, pl, alpha);
      const left = PAD_X + tx * TW;
      const top = PAD_TOP + ty * TH;
      v.node.style.transform = `translate3d(${left}px,${top}px,0)`;
      const z = rowZ(Math.round(ty), Z.PLAYER);
      if (v.z !== z) {
        v.node.style.zIndex = z;
        v.z = z;
      }
      v.node.style.display = 'block';
    }
    for (const [slot, v] of this.playerPool) {
      if (!seen.has(slot)) v.node.style.display = 'none';
    }
  }

  // -- Explosions (tile-locked; center = bright ring/core/drops) -------------
  private updateExplosions(next: SimState): void {
    const cells = new Set<string>();
    for (const c of next.explosions) cells.add(`${c.tileX},${c.tileY}`);
    const isCenter = (x: number, y: number): boolean =>
      (cells.has(`${x - 1},${y}`) || cells.has(`${x + 1},${y}`)) &&
      (cells.has(`${x},${y - 1}`) || cells.has(`${x},${y + 1}`));

    const seen = new Set<string>();
    for (const c of next.explosions) {
      const key = `${c.tileX},${c.tileY}`;
      seen.add(key);
      const center = isCenter(c.tileX, c.tileY);
      let v = this.explPool.get(key);
      if (v === undefined) {
        // No will-change here: a chain detonates many cells in one frame, and
        // promoting each to its own GPU layer at once is the burst hitch. They
        // paint above the already-cached tile layer, so tiles aren't repainted.
        const node = div(
          `position:absolute;left:${cellLeft(c.tileX)}px;top:${cellTop(c.tileY)}px;` +
            `width:${TW}px;height:${TH}px;z-index:${rowZ(c.tileY, Z.EXPL)};`,
        );
        this.explLayer.appendChild(node);
        v = { node, center: !center, op: '' };
        this.explPool.set(key, v);
      }
      if (v.center !== center) {
        v.node.innerHTML = explosionHtml(center);
        v.center = center;
      }
      // Fade out only over the final few ticks ("flame shown = it burns").
      const fade = Math.max(0, Math.min(1, c.ttlTicks / 5));
      const op = String(0.7 + 0.3 * fade);
      if (op !== v.op) {
        v.op = op;
        v.node.style.opacity = op;
      }
      v.node.style.display = 'block';
    }
    for (const [key, v] of this.explPool) {
      if (!seen.has(key)) v.node.style.display = 'none';
    }
  }

  // -- Shells (trapped players: dome + countdown) ----------------------------
  private updateShells(prev: SimState, next: SimState, alpha: number): void {
    const seen = new Set<number>();
    for (const pl of next.players) {
      if (!pl.alive || !pl.trapped) continue;
      seen.add(pl.slot);
      let v = this.shellPool.get(pl.slot);
      if (v === undefined) {
        const node = div(
          `position:absolute;left:0;top:0;width:${TW}px;height:${TH}px;will-change:transform;`,
        );
        node.innerHTML = shellHtml();
        const num = div(
          `position:absolute;left:0;top:-30px;width:${TW}px;text-align:center;` +
            `font-family:'Baloo 2','Nunito',sans-serif;font-weight:800;font-size:14px;` +
            `color:#7A4A2B;text-shadow:0 1px 0 #FFF5E0,0 0 3px #FFF5E0;`,
        );
        node.appendChild(num);
        this.shellLayer.appendChild(node);
        v = { node, num, z: '' };
        this.shellPool.set(pl.slot, v);
      }
      const prevPl = prev.players.find((p) => p.slot === pl.slot);
      const { tx, ty } = tileFrac(prevPl, pl, alpha);
      v.node.style.transform = `translate3d(${PAD_X + tx * TW}px,${PAD_TOP + ty * TH}px,0)`;
      const z = rowZ(Math.round(ty), Z.SHELL);
      if (v.z !== z) {
        v.node.style.zIndex = z;
        v.z = z;
      }
      v.num.textContent = (pl.trappedTicks / TICK_HZ).toFixed(1);
      v.node.style.display = 'block';
    }
    for (const [slot, v] of this.shellPool) {
      if (!seen.has(slot)) v.node.style.display = 'none';
    }
  }

  // -- HUD (timer pill · banner · per-player cards) --------------------------
  private updateHud(next: SimState): void {
    const clk = clockInfo(next);
    const timerKey = clk.text === '' ? '' : `${clk.text}|${clk.danger ? 1 : 0}`;
    if (timerKey !== this.lastTimer) {
      this.lastTimer = timerKey;
      if (clk.text === '') {
        this.timer.style.display = 'none';
      } else {
        this.timer.style.display = 'inline-flex';
        this.timer.textContent = clk.text;
        this.timer.style.animation = clk.danger ? 'cc-danger 1.1s ease-in-out infinite' : 'none';
        this.timer.style.color = clk.danger ? '#FFD2C2' : '#FBE9CF';
      }
    }

    const banner = bannerText(next, this.restartHint);
    if (banner !== this.lastBanner) {
      this.lastBanner = banner;
      this.banner.textContent = banner;
    }

    for (const pl of next.players) {
      let card = this.cardPool.get(pl.slot);
      if (card === undefined) {
        card = buildCard(pl.slot, this.cards);
        this.cardPool.set(pl.slot, card);
      }
      const pal = teamPalette(pl.team);
      const bg = `linear-gradient(165deg,${pal.hi},${pal.base} 58%,${pal.lo})`;
      if (bg !== card.lastBg) {
        card.lastBg = bg;
        card.dot.style.background = bg;
      }
      const name = this.slotLabels[pl.slot] ?? `P${pl.slot + 1}`;
      if (name !== card.lastName) {
        card.lastName = name;
        card.name.textContent = name;
      }
      const spd = (pl.speedBonusTenths / 10).toFixed(1);
      const stats = !pl.alive
        ? '出局'
        : pl.trapped
          ? `糖殼 ${(pl.trappedTicks / TICK_HZ).toFixed(1)}s`
          : `火${pl.fire} 彈${pl.activeBombs}/${pl.cannon} 速+${spd}`;
      const opacity = pl.alive ? '1' : '0.5';
      if (stats !== card.lastStats) {
        card.lastStats = stats;
        card.stats.textContent = stats;
      }
      if (opacity !== card.lastOpacity) {
        card.lastOpacity = opacity;
        card.root.style.opacity = opacity;
      }
    }
  }
}

interface CardView {
  root: HTMLDivElement;
  dot: HTMLDivElement;
  name: HTMLDivElement;
  stats: HTMLDivElement;
  lastBg?: string;
  lastName?: string;
  lastStats?: string;
  lastOpacity?: string;
}

function buildCard(slot: number, parent: HTMLElement): CardView {
  void slot;
  const root = div(
    'display:flex;align-items:center;gap:9px;height:48px;padding:0 14px 0 8px;' +
      'background:#fff;border-radius:14px;box-shadow:0 4px 0 #EAD6B8;',
    parent,
  );
  const dot = div(
    'width:30px;height:30px;border-radius:50%;flex:none;box-shadow:inset 0 -3px 4px rgba(0,0,0,.12),inset 0 3px 4px rgba(255,255,255,.5);',
    root,
  );
  const txt = div('display:flex;flex-direction:column;line-height:1.2;', root);
  const name = div(
    "font-family:'Baloo 2','Nunito',sans-serif;font-weight:700;font-size:14px;color:#5A3420;",
    txt,
  );
  const stats = div('font-weight:800;font-size:11px;color:#A88C70;', txt);
  return { root, dot, name, stats };
}

/** Remaining clock for the timer pill; skull prefix once sudden death is on. */
function clockInfo(state: SimState): { text: string; danger: boolean } {
  if (state.phase !== GamePhase.PLAYING) return { text: '', danger: false };
  const remTicks = Math.max(0, MATCH_MAX_TICKS - state.tick);
  const secs = Math.ceil(remTicks / TICK_HZ);
  const clock = `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
  return state.tick >= SUDDEN_DEATH_START_TICK
    ? { text: `☠ ${clock}`, danger: true }
    : { text: clock, danger: false };
}

function bannerText(state: SimState, restartHint: boolean): string {
  if (state.phase === GamePhase.PLAYING) return '對戰中 — 最後存活隊伍獲勝！';
  if (state.phase === GamePhase.OVER) {
    const suffix = restartHint ? '（按 R 再來一場）' : '';
    const { winnerTeam } = resolveOutcome(state);
    if (winnerTeam === null) {
      return state.players.some((p) => p.alive)
        ? `平手 — 時間到，不分高下。${suffix}`
        : `平手 — 全員糖殼化。${suffix}`;
    }
    return state.tick >= MATCH_MAX_TICKS
      ? `時間到 — 隊伍 ${winnerTeam} 獲勝（存活／發育）！${suffix}`
      : `甜蜜勝利 — 最後存活隊伍！${suffix}`;
  }
  return '大廳';
}

/** One tile's inner HTML: checkerboard floor + (optional) raised candy cube. */
function tileInner(kind: number, x: number, y: number): string {
  return (
    floorHtml((x + y) & 1) +
    (kind === TileKind.HARD
      ? cubeHtml('wall')
      : kind === TileKind.SOFT
        ? cubeHtml('block')
        : '')
  );
}
