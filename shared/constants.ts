/**
 * Cocoa Clash — single source of truth for all fixed constants.
 *
 * Every value here traces back to CLAUDE.md (design spec). The Python server
 * keeps a hand-aligned copy of whatever it needs; this file is authoritative.
 *
 * IMPORTANT (determinism): all sim positions/velocities are stored as
 * **integer millitiles** (see MILLITILE). Time is counted in ticks, never ms,
 * inside the simulation.
 */

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Logic update rate: fixed 60 Hz timestep (rendering runs separately on rAF). */
export const TICK_HZ = 60;
/** Milliseconds per logic tick (scheduling only — never stored in sim state). */
export const TICK_MS = 1000 / TICK_HZ;

// ---------------------------------------------------------------------------
// Map — 15×13 tiles, 44px tiles; outer ring + even (x,y) coordinates are hard bricks
// ---------------------------------------------------------------------------

export const MAP_COLS = 15;
export const MAP_ROWS = 13;
/** Pixel size of one tile (rendering only). */
export const TILE_PX = 44;

/** Soft-brick generation rate over eligible tiles (spec: 72%). */
export const SOFT_BRICK_RATE = 0.72;
/** Tiles kept clear around each spawn corner (spec: 3). */
export const SPAWN_CLEAR_TILES = 3;

// ---------------------------------------------------------------------------
// Bombs / explosions (chocolate: place → melt)
// ---------------------------------------------------------------------------

/** Fuse: 3.0 s from placing the chocolate to melting (exploding). */
export const FUSE_TICKS = Math.round(3.0 * TICK_HZ); // 180

/**
 * Spark (melt-flow) duration: 0.45 s. Cross-shaped flow, stops at hard bricks,
 * stops after destroying a soft brick, chains other bombs.
 */
export const SPARK_TICKS = Math.round(0.45 * TICK_HZ); // 27

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Soft bricks drop an item 50% of the time. */
export const ITEM_DROP_RATE = 0.50;
/** Fire / speed / cannon each 1/3 when an item drops. */
export const ITEM_KIND_WEIGHT = 1 / 3;

// ---------------------------------------------------------------------------
// Trap (sugar shell) / respawn
// ---------------------------------------------------------------------------

/**
 * Trapped survival window: 5.0 s inside the solidified sugar shell.
 * Teammate touch = rescue; timeout = shell breaks, eliminated.
 */
export const TRAPPED_TICKS = Math.round(5.0 * TICK_HZ); // 300

/** Respawn protection: 4.0 s (respawn mode only; covers the spawn instant). */
export const RESPAWN_PROTECT_TICKS = Math.round(4.0 * TICK_HZ); // 240

// ---------------------------------------------------------------------------
// Match length
// ---------------------------------------------------------------------------

/**
 * Hard match time cap: 3.0 min. The sim forces phase OVER at this tick even if
 * more than one team is still standing; the surviving teams are then resolved by
 * "most survivors → item-progress tiebreak → draw" (see sim/Outcome.ts). The
 * AI-eval benches and spectate use the same cap so every context agrees.
 */
export const MATCH_MAX_TICKS = Math.round(180 * TICK_HZ); // 10800

// ---------------------------------------------------------------------------
// Sudden death — late-match arena shrink that forces a result before the cap
// ---------------------------------------------------------------------------

/**
 * From this tick on, the play area closes in: one interior tile hardens to a
 * HARD brick every SUDDEN_DEATH_TILE_INTERVAL ticks in an inward spiral (outer
 * ring of the interior first, center last). An alive player caught on a
 * hardening tile is crushed — eliminated outright, no shell/rescue (a fully
 * solidified tile entombs). This kills the farm-to-timeout stall: equal-speed
 * evasion no longer works once there is nowhere left to flee.
 *
 * Tuning: the 13×11 = 143 interior tiles finish hardening at
 * START + 143*INTERVAL = 7200 + 3575 = 10775 (~179.6 s), just under the cap, so
 * a match cannot reach MATCH_MAX_TICKS with two players still standing. Both are
 * pure balance knobs (no determinism impact beyond the grid they harden).
 */
// ponytail: START is "後段" (last third). Lower it for more pressure time.
export const SUDDEN_DEATH_START_TICK = 7200; // 120 s
export const SUDDEN_DEATH_TILE_INTERVAL = 25; // ticks per hardened tile

// ---------------------------------------------------------------------------
// Player initial values & caps
// ---------------------------------------------------------------------------

/** 1 life (melt-hit → trapped in sugar shell, not killed outright). */
export const PLAYER_START_HP = 1;
/** Starting fire power (cross-flow reach in tiles). */
export const PLAYER_START_FIRE = 2;
/** Max fire power. Balance: raised 6 -> 7 (high-blast build: longer melt-flow
 * cross to seal/wall larger areas). Re-pins golden + re-seeds the BT yardstick. */
export const PLAYER_MAX_FIRE = 7;
/** Starting simultaneous bomb count. */
export const PLAYER_START_CANNON = 1;
/** Max simultaneous bombs. Balance: raised 5 -> 6 (more bombs to build larger
 * blockades). Re-pins golden + re-seeds the BT yardstick. */
export const PLAYER_MAX_CANNON = 6;
/** Speed bonus: starts at 0, +0.4 tiles/s per item, capped at +2.0. */
export const PLAYER_START_SPEED_BONUS = 0;
export const SPEED_BONUS_PER_ITEM = 0.4;
export const SPEED_BONUS_CAP = 2.0;

// ---------------------------------------------------------------------------
// Feel parameters — panel-adjustable defaults (frozen per match via FeelParams)
// ---------------------------------------------------------------------------

/** Move speed in tiles/s (range 3–8). */
export const DEFAULT_MOVE_SPEED = 5.0;
/** Corner-assist tolerance in tiles (range 0–0.5). */
export const DEFAULT_CORNER_ASSIST = 0.25;
/** Input buffer in ms (range 0–250). */
export const DEFAULT_INPUT_BUFFER_MS = 120;

// ---------------------------------------------------------------------------
// Fixed-point coordinates
// ---------------------------------------------------------------------------

/**
 * Fixed-point scale: 1 tile = 1000 millitiles.
 * ALL sim positions are int32 millitiles (integer tile center = x * MILLITILE).
 * millitile → px for rendering: `mt * TILE_PX / MILLITILE`.
 */
export const MILLITILE = 1000;

// ---------------------------------------------------------------------------
// Lockstep netcode
// ---------------------------------------------------------------------------

/** Local input at tick T is scheduled for sim tick T + INPUT_DELAY_TICKS (~33 ms). */
export const INPUT_DELAY_TICKS = 2;
/** Missing-input stall tolerance before server/client signal a stall. */
export const STALL_TIMEOUT_MS = 200;
/** Clients report their state hash every N ticks for desync detection. */
export const HASH_REPORT_INTERVAL = 30;
