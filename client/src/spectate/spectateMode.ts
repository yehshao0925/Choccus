/**
 * Bot-vs-bot SPECTATOR mode (?mode=spectate). Watch two (or more) AI bots fight
 * with NO human player. Purely additive: ?mode=solo and the online/net path are
 * untouched.
 *
 * Like solo mode, the spectator owns ALL wall-clock timing via a rAF loop with a
 * fixed-timestep accumulator; the sim only ever receives whole ticks built from
 * each slot's bot controller. A SPEED multiplier runs `speed` sim-ticks per
 * TICK_MS of accumulated time so a match can be watched faster. Rendering
 * interpolates between the last two states with alpha = acc / TICK_MS.
 *
 * Every slot is a bot, so no keyboard input ever enters the sim. Math.random()
 * is used ONLY to pick the per-match seed (exactly as solo mode documents); the
 * simulation given that seed stays fully deterministic.
 *
 * Match config comes from URL params (all with sensible defaults):
 *   ?lineup=2-chaosv,1-gambler  one VERSION-ARCHETYPE token per slot (2..4)
 *   ?map=classic|pirate         arena layout (default classic)
 *   ?speed=1|2|4|8              sim-speed multiplier (default 4)
 *   ?maxTicks=10800            per-match tick cap (default 10800 = 3 min, min 60)
 *
 * On every match end a running SCOREBOARD (keyed by contestant label) updates,
 * then a fresh match auto-restarts after ~1.5s with a fresh seed.
 */
import { MATCH_MAX_TICKS, TICK_MS } from '../../../shared/constants';
import { GamePhase } from '../../../shared/types';
import { AI_VERSIONS, type BotSpec, type IBotController, LATEST_AI_VERSION } from '../ai';
import { makeFeelParams } from '../config/FeelParams';
import { Renderer } from '../render/Renderer';
import { type InputFrame } from '../sim/InputBuffer';
import type { MapKind } from '../sim/Map';
import { resolveOutcome } from '../sim/Outcome';
import { type SimState, createInitialState, tick } from '../sim/Sim';

/**
 * Pick a fresh uint32 seed for a match. Using Math.random() here is fine: it
 * only PICKS the seed — the simulation given that seed stays fully deterministic
 * and the spectator has no lockstep partner. (Never use Math.random() inside the
 * sim itself; see sim/Prng.ts.)
 */
const randomSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

/** Clamp big frame gaps (tab switch, breakpoint) to avoid a spiral of death. */
const MAX_FRAME_MS = 250;

/**
 * Archetype keys spectate accepts in `?lineup=`. Covers every key across all AI
 * versions: v1/v2 use aggressor/turtle/gambler/chaosv; v3 is the 7-archetype
 * limited-kill roster hunter/farmer/zoner/runner/trapper/reactive/noise. A key a
 * given version doesn't define falls back to that version's difficulty tuning
 * (e.g. 2-trapper → v2 normal).
 */
const ARCHETYPE_KEYS = [
  'aggressor', 'turtle', 'gambler', 'chaosv', 'tempering', 'farmer',
  'hunter', 'zoner', 'runner', 'trapper', 'reactive', 'noise',
] as const;
type ArchetypeKey = (typeof ARCHETYPE_KEYS)[number];

/** Display name per archetype key (note ChaosV's mixed case). */
const ARCHETYPE_LABEL: Readonly<Record<ArchetypeKey, string>> = {
  aggressor: 'Aggressor',
  turtle: 'Turtle',
  gambler: 'Gambler',
  chaosv: 'ChaosV',
  tempering: 'Tempering',
  farmer: 'Farmer',
  hunter: 'Hunter',
  zoner: 'Zoner',
  runner: 'Runner',
  trapper: 'Trapper',
  reactive: 'Reactive',
  noise: 'Noise',
};

/** Allowed sim-speed multipliers. */
const SPEEDS = [1, 2, 4, 8] as const;
type Speed = (typeof SPEEDS)[number];

/** A contestant: an AI version paired with an archetype key, plus its label. */
interface Contestant {
  version: number;
  archetypeKey: ArchetypeKey;
  /** "v{ver}-{Archetype}", e.g. "v2-ChaosV". */
  label: string;
}

/** Build a contestant from a version + archetype key, deriving its label. */
function makeContestant(version: number, archetypeKey: ArchetypeKey): Contestant {
  return {
    version,
    archetypeKey,
    label: `v${version}-${ARCHETYPE_LABEL[archetypeKey]}`,
  };
}

/** Build the deterministic bot controller for a contestant in a given slot. */
function makeController(c: Contestant, seed: number, slot: number): IBotController {
  const spec: BotSpec = { difficulty: 'normal', strategyRaw: c.archetypeKey };
  return AI_VERSIONS[c.version]!.createBot(seed, slot, spec);
}

/**
 * Parse a "VERSION-ARCHETYPE" token (e.g. "2-chaosv"). Splits on '-': part 0 is
 * the integer AI version (unknown → LATEST_AI_VERSION), part 1 is the archetype
 * key (unknown/missing → 'aggressor').
 */
function parseToken(token: string): Contestant {
  const parts = token.split('-');
  const verNum = Number.parseInt((parts[0] ?? '').trim(), 10);
  const version =
    Number.isFinite(verNum) && AI_VERSIONS[verNum] !== undefined
      ? verNum
      : LATEST_AI_VERSION;
  const keyRaw = (parts[1] ?? '').trim().toLowerCase();
  const archetypeKey = (ARCHETYPE_KEYS as readonly string[]).includes(keyRaw)
    ? (keyRaw as ArchetypeKey)
    : 'aggressor';
  return makeContestant(version, archetypeKey);
}

/** Parse ?lineup= into 2..4 contestants (default a v2-ChaosV vs v1-Gambler 1v1). */
function parseLineup(raw: string | null): Contestant[] {
  const tokens = (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length < 2) {
    return [parseToken('2-chaosv'), parseToken('1-gambler')];
  }
  return tokens.slice(0, 4).map(parseToken);
}

/** Map kind: ?map=classic|pirate (case-insensitive); anything else → classic. */
function parseMapKind(raw: string | null): MapKind {
  return raw?.toLowerCase() === 'pirate' ? 'pirate' : 'classic';
}

/** Speed multiplier: ?speed=1|2|4|8; anything else → 4. */
function parseSpeed(raw: string | null): Speed {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return (SPEEDS as readonly number[]).includes(n) ? (n as Speed) : 4;
}

/** Tick cap: ?maxTicks= (default 10800 = 3 min, floored at 60). */
function parseMaxTicks(raw: string | null): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(n) ? Math.max(60, Math.trunc(n)) : MATCH_MAX_TICKS;
}

export async function runSpectate(params: URLSearchParams): Promise<void> {
  // Mutable match config (the on-screen pickers mutate these, then restart()).
  // `lineup` itself is never rebound — the contestant pickers replace its slot
  // entries in place — so it stays const.
  const lineup: Contestant[] = parseLineup(params.get('lineup'));
  let mapKind: MapKind = parseMapKind(params.get('map'));
  let speed: Speed = parseSpeed(params.get('speed'));
  const maxTicks: number = parseMaxTicks(params.get('maxTicks'));

  const feel = makeFeelParams();

  // Per-contestant-label running tally + a shared draws/played counter.
  let wins = new Map<string, number>();
  let draws = 0;
  let played = 0;

  // Current match state. Re-seeded + rebuilt on every restart().
  let seed = randomSeed();
  let cur: SimState = newState();
  let prev: SimState = cur;
  let controllers: IBotController[] = buildControllers();
  // Per-match guard: tally the result exactly once, even though the OVER phase
  // (or tick cap) persists for several frames until the auto-restart fires.
  let matchScored = false;

  /** FFA (teams undefined → each slot its own team), pvp last-team-standing. */
  function newState(): SimState {
    return createInitialState(seed, feel, lineup.length, {
      pvp: true,
      map: mapKind,
    });
  }

  /** One deterministic bot brain per slot, derived from the current seed. */
  function buildControllers(): IBotController[] {
    return lineup.map((c, slot) => makeController(c, seed, slot));
  }

  const renderer = await Renderer.create();
  const mount = document.getElementById('app');
  if (!mount) {
    throw new Error('#app mount point missing');
  }
  mount.appendChild(renderer.canvas);

  // Render-layer-only HUD bits (never touch the sim).
  const applyHud = (): void => {
    renderer.setSlotLabels(lineup.map((c) => c.label));
    const a = lineup[0]?.label ?? '?';
    const b = lineup[1]?.label ?? '?';
    renderer.setHudHint(`Spectator — ${a} vs ${b}`, false);
  };
  applyHud();

  // ---- Scoreboard panel (top-center) -------------------------------------
  const scoreboard = document.createElement('div');
  scoreboard.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:900;' +
    'padding:6px 16px;background:rgba(61,28,2,0.85);color:#f5e6d3;border-radius:8px;' +
    'font:14px system-ui,sans-serif;white-space:nowrap;text-align:center;';
  document.body.appendChild(scoreboard);

  const renderScoreboard = (): void => {
    const parts = lineup.map((c) => `${c.label}  ${wins.get(c.label) ?? 0}`);
    scoreboard.textContent = `${parts.join('   —   ')}   (draws ${draws}, ${played} played)`;
  };
  renderScoreboard();

  // ---- Config pickers (top-left, same brown style as solo) ----------------
  const pickerCss =
    'position:fixed;left:8px;z-index:900;padding:6px 12px;' +
    'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
    'font:13px system-ui,sans-serif;cursor:pointer;';

  // All 8 selectable agents: v1/v2 × {Aggressor, Turtle, Gambler, ChaosV}.
  const versions = Object.keys(AI_VERSIONS).map(Number).sort((x, y) => x - y);
  const allAgents: Contestant[] = [];
  for (const v of versions) {
    for (const k of ARCHETYPE_KEYS) allAgents.push(makeContestant(v, k));
  }
  /** Build a <select> of every agent, pre-selecting `current`. */
  const buildAgentPicker = (top: number, current: Contestant): HTMLSelectElement => {
    const sel = document.createElement('select');
    sel.style.cssText = `${pickerCss}top:${top}px;`;
    for (const a of allAgents) {
      const opt = document.createElement('option');
      opt.value = `${a.version}-${a.archetypeKey}`;
      opt.textContent = a.label;
      if (a.version === current.version && a.archetypeKey === current.archetypeKey) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    }
    return sel;
  };

  // Map picker.
  const mapPicker = document.createElement('select');
  mapPicker.style.cssText = `${pickerCss}top:8px;`;
  for (const [value, text] of [
    ['classic', 'Classic'],
    ['pirate', 'Pirate'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === mapKind) opt.selected = true;
    mapPicker.appendChild(opt);
  }
  mapPicker.addEventListener('change', () => {
    mapKind = parseMapKind(mapPicker.value);
    restartFresh();
  });
  document.body.appendChild(mapPicker);

  // Speed picker.
  const speedPicker = document.createElement('select');
  speedPicker.style.cssText = `${pickerCss}top:44px;`;
  for (const s of SPEEDS) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = `${s}×`;
    if (s === speed) opt.selected = true;
    speedPicker.appendChild(opt);
  }
  speedPicker.addEventListener('change', () => {
    speed = parseSpeed(speedPicker.value);
    // Speed alone doesn't change the match outcome, but resetting keeps the
    // scoreboard semantics consistent (a knob change starts a fresh contest).
    restartFresh();
  });
  document.body.appendChild(speedPicker);

  // Two contestant pickers (slot0 / slot1). Even when a URL lineup has >2 slots
  // we expose only the first two (the default/important case is 1v1).
  const slot0Picker = buildAgentPicker(80, lineup[0] ?? makeContestant(LATEST_AI_VERSION, 'aggressor'));
  const slot1Picker = buildAgentPicker(116, lineup[1] ?? makeContestant(LATEST_AI_VERSION, 'aggressor'));
  const onContestantChange = (): void => {
    lineup[0] = parseToken(slot0Picker.value);
    lineup[1] = parseToken(slot1Picker.value);
    restartFresh();
  };
  slot0Picker.addEventListener('change', onContestantChange);
  slot1Picker.addEventListener('change', onContestantChange);
  document.body.appendChild(slot0Picker);
  document.body.appendChild(slot1Picker);

  // ---- Match lifecycle ----------------------------------------------------
  let restartTimer: ReturnType<typeof setTimeout> | undefined;

  /** Start a fresh match (new seed, rebuilt bots) keeping the scoreboard. */
  const restartMatch = (): void => {
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    seed = randomSeed();
    controllers = buildControllers();
    cur = newState();
    prev = cur;
    matchScored = false;
    acc = 0;
    applyHud();
  };

  /** A config knob changed: reset the scoreboard, then start a fresh match. */
  function restartFresh(): void {
    wins = new Map<string, number>();
    draws = 0;
    played = 0;
    renderScoreboard();
    restartMatch();
  }

  /** Tally the finished match into the scoreboard (called once per match). */
  const scoreMatch = (): void => {
    // Each bot is its own team (FFA), so the shared resolver's winnerSlot is the
    // winning contestant: clean last-bot-standing, or — at the cap — most
    // survivors → item tiebreak → draw.
    const { winnerSlot } = resolveOutcome(cur);
    played += 1;
    if (winnerSlot === null) {
      draws += 1;
    } else {
      const label = lineup[winnerSlot]!.label;
      wins.set(label, (wins.get(label) ?? 0) + 1);
    }
    renderScoreboard();
  };

  let acc = 0;
  let last: number | undefined;

  const frame = (now: number): void => {
    const dt = last === undefined ? 0 : Math.min(now - last, MAX_FRAME_MS);
    last = now;
    acc += dt;

    while (acc >= TICK_MS) {
      // SPEED: run `speed` sim-ticks per TICK_MS of accumulated time.
      for (let step = 0; step < speed; step++) {
        const inputs: InputFrame[] = [];
        for (let s = 0; s < lineup.length; s++) {
          inputs.push(controllers[s]!.sample(cur, s));
        }
        prev = cur;
        cur = tick(cur, inputs);
        if (cur.phase === GamePhase.OVER || cur.tick >= maxTicks) break;
      }
      acc -= TICK_MS;
    }

    // Match end: tally once, then schedule a fresh match ~1.5s later.
    if ((cur.phase === GamePhase.OVER || cur.tick >= maxTicks) && !matchScored) {
      matchScored = true;
      scoreMatch();
      restartTimer = setTimeout(restartMatch, 1500);
    }

    renderer.render(prev, cur, acc / TICK_MS);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
