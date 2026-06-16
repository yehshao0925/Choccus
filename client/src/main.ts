/**
 * Entry point. Mode switch via URL:
 *   (default)   — online lobby (create / join / quick match); see net/netMode.ts.
 *   ?mode=solo  — solo practice: one human player vs N AI bots (last survivor wins).
 *
 * Solo mode owns ALL wall-clock timing: a rAF loop with a fixed-timestep
 * accumulator. The sim only ever receives whole ticks; rendering interpolates
 * between the last two states with alpha = acc / TICK_MS.
 *
 * Controls — Arrows move · Space drops chocolate · R: start a new random match.
 *
 * Each match uses a FRESH random seed (initial load and every reset), so item
 * drops and bot play vary from match to match. The layout still depends on the
 * chosen MapKind: authored kinds (e.g. 'pirate') look the same every match,
 * while the rolled kind ('classic') also varies with the seed. The R key
 * starts a NEW random match rather than replaying the same one.
 *
 * Feel params (hotseat only): the ⚙ FeelPanel adjusts move speed / corner
 * assist / input buffer. Releasing a slider rebuilds the initial state (an
 * R-reset, never a mid-match swap), which re-rolls the seed too. Online mode
 * never shows the panel — its params come from MatchStart.
 */
import { TICK_MS } from '../../shared/constants';
import { GamePhase } from '../../shared/types';
import {
  AI_VERSIONS,
  type BotSpec,
  type IBotController,
  LATEST_AI_VERSION,
  parseDifficulty,
} from './ai';
import { matchSound } from './audio/MatchSound';
import { sfx } from './audio/Sfx';
import { type FeelParams, makeFeelParams } from './config/FeelParams';
import { KeyboardInput } from './input/KeyboardInput';
import { sampleLocalInput } from './input/InputMapper';
import { runNetMode } from './net/netMode';
import { Renderer } from './render/Renderer';
import { type InputFrame, NO_INPUT } from './sim/InputBuffer';
import type { MapKind } from './sim/Map';
import { type SimState, createInitialState, tick } from './sim/Sim';
import { FeelPanel } from './ui/FeelPanel';

/**
 * Pick a fresh uint32 seed for a solo match. Using Math.random() here is fine:
 * it only PICKS the seed — the simulation given that seed stays fully
 * deterministic. Solo has no lockstep partner, so this never affects netcode.
 * (Never use Math.random() inside the sim itself; see sim/Prng.ts.)
 */
const randomSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

/** Clamp big frame gaps (tab switch, breakpoint) to avoid a spiral of death. */
const MAX_FRAME_MS = 250;

async function bootstrapSolo(params: URLSearchParams): Promise<void> {
  // Bot count: default 1 when ?bots is absent; clamped to 0..3 otherwise.
  // Mutable so the bot-count picker can change it; reset() then rebuilds the
  // match with 1 + bots players. numPlayers is computed at each use site.
  const botsRaw = Number(params.get('bots'));
  let bots = !params.has('bots')
    ? 1
    : Number.isNaN(botsRaw)
      ? 1
      : Math.max(0, Math.min(3, Math.trunc(botsRaw)));
  const difficulty = parseDifficulty(params.get('difficulty'));

  // Team format: 'ffa' (default) = everyone on their own team, bot-count picker
  // active. '2v2' = fixed 4 players, diagonal teams [0,1,1,0] (human slot0 +
  // slot3 vs slots1,2), bot count forced to 3. ?format=ffa|2v2 (case-insensitive,
  // else → ffa) sets the initial value.
  type TeamFormat = 'ffa' | '2v2';
  const parseFormat = (raw: string | null): TeamFormat =>
    raw?.toLowerCase() === '2v2' ? '2v2' : 'ffa';
  let format: TeamFormat = parseFormat(params.get('format'));

  // Diagonal teams for 2v2: human slot0 + slot3 vs slots1,2.
  const TEAMS_2V2: readonly number[] = [0, 1, 1, 0];

  // Effective bot count for the current format: forced to 3 in 2v2 (4 players
  // total), otherwise the picker value. Used at every count consumption site
  // (numPlayers, buildBots loop, per-tick bot sampling) WITHOUT mutating `bots`,
  // so switching back to FFA restores the picker selection.
  const effectiveBots = (): number => (format === '2v2' ? 3 : bots);

  // Team array passed to createInitialState: the fixed 2v2 diagonal, or
  // undefined in FFA (keeps the FFA path byte-for-byte equivalent to before).
  const teamsForFormat = (): readonly number[] | undefined =>
    format === '2v2' ? TEAMS_2V2 : undefined;

  // Named-strategy mode (?strategy=). Independent of difficulty: when a strategy
  // is given, every bot uses the strategy tuning and difficulty is ignored;
  // when absent, bots fall back to the difficulty tuning. Strategy/tuning/name
  // resolution lives in each AI version's module (see ai/index.ts); we just pass
  // the raw spec through. All assignment is fully deterministic (no Math.random)
  // — safe for lockstep.
  //   ?strategy=aggressor|turtle|gambler|chaosv → all bots use that archetype.
  //   ?strategy=mix (or random)                 → each bot cycles a distinct
  //                                               archetype by its bot index.
  //
  // Per-slot AI version (?botVersions=). Comma list, index = slot-1 (slot 1 is
  // the first bot), e.g. ?botVersions=2,1,2. Missing/short/empty entries → the
  // latest version; unknown numbers are clamped to the latest. Default (param
  // absent) → every bot runs the latest version. Version choice is a render/
  // factory concern only; it NEVER enters SimState/stateHash.
  const strategyRaw = (params.get('strategy') ?? '').toLowerCase().trim();
  // Version-agnostic spec handed to the chosen AI version module per slot.
  const botSpec: BotSpec = { difficulty, strategyRaw };

  // Parse ?botVersions= into a per-bot-index list of AI version numbers.
  const versionList: number[] = (params.get('botVersions') ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10));
  // AI version for an AI slot (1..bots). bot index = slot - 1. Unknown/missing
  // entries fall back to the latest registered version.
  const versionForSlot = (slot: number): number => {
    const v = versionList[slot - 1];
    return v !== undefined && Number.isFinite(v) && AI_VERSIONS[v] !== undefined
      ? v
      : LATEST_AI_VERSION;
  };
  // The AI version module driving a given AI slot.
  const moduleForSlot = (slot: number): (typeof AI_VERSIONS)[number] =>
    AI_VERSIONS[versionForSlot(slot)]!;

  // Render-layer-only slot→label table (index = player slot). slot 0 = human.
  // NEVER goes into SimState/stateHash; consumed solely by the HUD. Rebuilt on
  // every reset() so HUD labels track the current bot count.
  // Bot brain display name for an AI slot (1..N): the chosen version module's
  // name, suffixed with ` vN` when the slot is not on the latest version so a
  // mixed-version match is legible in the HUD (render-only).
  const botName = (slot: number): string => {
    const version = versionForSlot(slot);
    const base = AI_VERSIONS[version]!.botNameFor(slot, botSpec);
    return version === LATEST_AI_VERSION ? base : `${base} v${version}`;
  };
  const buildSlotLabels = (): (string | undefined)[] => {
    if (format === '2v2') {
      // Diagonal teams [0,1,1,0]: slot0 = you, slot3 = ally, slots1,2 = enemies.
      return [
        'YOU',
        botName(1),
        botName(2),
        `ALLY (${botName(3)})`,
      ];
    }
    const labels: (string | undefined)[] = ['YOU'];
    for (let slot = 1; slot <= bots; slot++) labels.push(botName(slot));
    return labels;
  };

  // Render-layer-only HUD hint text. Rebuilt on every reset() so the bot count
  // shown tracks the current picker selection.
  const buildHint = (): string => {
    if (format === '2v2') {
      return `2v2 Team (${difficulty}) — Arrows move · Space drops chocolate`;
    }
    return bots > 0
      ? `Solo +${bots} AI (${difficulty}) — Arrows move · Space drops chocolate`
      : 'Solo — Arrows move · Space drops chocolate';
  };

  // Map kind: ?map=classic|pirate (case-insensitive); anything else → classic.
  const parseMapKind = (raw: string | null): MapKind => {
    switch (raw?.toLowerCase()) {
      case 'pirate':
        return 'pirate';
      default:
        return 'classic';
    }
  };
  let mapKind: MapKind = parseMapKind(params.get('map'));

  let feel: FeelParams = makeFeelParams();
  // Current match seed — re-rolled on every reset() so each match plays out
  // differently (item drops + bot play). buildBots / createInitialState below
  // read this current value.
  let seed = randomSeed();
  // FFA: team = slot (human team 0 vs each bot on its own team). 2v2: diagonal
  // teams [0,1,1,0]. last team standing wins.
  let cur: SimState = createInitialState(seed, feel, 1 + effectiveBots(), {
    pvp: true,
    map: mapKind,
    teams: teamsForFormat(),
  });
  let prev: SimState = cur;

  // Deterministic bot brains, one per AI slot (1..effectiveBots). Reads the
  // current match seed at call time → bots re-derive from the new seed each
  // match. Each slot's brain comes from its chosen AI version module.
  const buildBots = (): IBotController[] => {
    const arr: IBotController[] = [];
    for (let slot = 1; slot <= effectiveBots(); slot++) {
      arr.push(moduleForSlot(slot).createBot(seed, slot, botSpec));
    }
    return arr;
  };
  let botControllers = buildBots();

  const keyboard = new KeyboardInput();
  keyboard.attach(window);

  const renderer = await Renderer.create();
  renderer.setSlotLabels(buildSlotLabels());
  renderer.setHudHint(buildHint(), true);
  const mount = document.getElementById('app');
  if (!mount) {
    throw new Error('#app mount point missing');
  }
  mount.appendChild(renderer.canvas);

  let acc = 0;
  let last: number | undefined;
  let audioUnlocked = false;

  // Auto-restart on game over (pure client orchestration — no sim effect). When
  // the match ends we schedule a single reset() ~2.5s later so the player need
  // not press R. `restartScheduled` guards against firing more than once per
  // match; `restartTimer` lets reset() cancel a still-pending auto-restart
  // (e.g. when R is pressed during the window).
  let restartScheduled = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;

  /** Start a NEW random match (R-reset / feel apply / map change / auto-restart). */
  const reset = (): void => {
    // Cancel any pending auto-restart and clear the per-match guard so the next
    // match can auto-restart when it ends.
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    restartScheduled = false;
    // Re-roll first so buildBots() and createInitialState() see the new seed.
    seed = randomSeed();
    botControllers = buildBots();
    // FFA: team = slot. 2v2: diagonal teams [0,1,1,0].
    cur = createInitialState(seed, feel, 1 + effectiveBots(), {
      pvp: true,
      map: mapKind,
      teams: teamsForFormat(),
    });
    prev = cur;
    // Render-layer only: refresh HUD labels/hint so a changed bot count shows.
    renderer.setSlotLabels(buildSlotLabels());
    renderer.setHudHint(buildHint(), true);
    acc = 0;
  };

  // Unlock audio on first user gesture.
  const unlockAudio = (): void => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    sfx.resumeContext();
    soundHint.style.display = 'none';
  };

  // R = reset: start a new random match (fresh seed).
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    unlockAudio();
    if (e.code === 'KeyR') reset();
  });
  window.addEventListener('click', unlockAudio, { once: false });

  // Mute toggle button.
  const muteBtn = document.createElement('button');
  muteBtn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:900;padding:6px 12px;' +
    'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
    'font:13px system-ui,sans-serif;cursor:pointer;';
  const updateMuteBtn = (): void => {
    muteBtn.textContent = sfx.muted ? '🔇 Muted' : '🔊 Sound On';
  };
  updateMuteBtn();
  muteBtn.addEventListener('click', () => {
    sfx.toggleMute();
    updateMuteBtn();
  });
  document.body.appendChild(muteBtn);

  // Solo map picker (top-left; mute button is top-right). Changing it starts a
  // new random match with the chosen layout.
  const mapPicker = document.createElement('select');
  mapPicker.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:900;padding:6px 12px;' +
    'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
    'font:13px system-ui,sans-serif;cursor:pointer;';
  const mapOptions: ReadonlyArray<readonly [MapKind, string]> = [
    ['classic', 'Classic'],
    ['pirate', 'Pirate'],
  ];
  for (const [value, label] of mapOptions) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === mapKind) opt.selected = true;
    mapPicker.appendChild(opt);
  }
  mapPicker.addEventListener('change', () => {
    mapKind = parseMapKind(mapPicker.value);
    reset();
  });
  document.body.appendChild(mapPicker);

  // Solo bot-count picker (second row, below the map picker; top-right stays the
  // mute button). Changing it starts a new random match with 1 + N players.
  const botPicker = document.createElement('select');
  botPicker.style.cssText =
    'position:fixed;top:44px;left:8px;z-index:900;padding:6px 12px;' +
    'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
    'font:13px system-ui,sans-serif;cursor:pointer;';
  for (let n = 0; n <= 3; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = n === 1 ? '1 Bot' : `${n} Bots`;
    if (n === bots) opt.selected = true;
    botPicker.appendChild(opt);
  }
  botPicker.addEventListener('change', () => {
    bots = Math.max(0, Math.min(3, Math.trunc(Number(botPicker.value))));
    reset();
  });
  document.body.appendChild(botPicker);

  // Solo team-format picker (third row, below the bot-count picker). 2v2 forces
  // a fixed 4-player diagonal-team match and disables the bot-count picker.
  const formatPicker = document.createElement('select');
  formatPicker.style.cssText =
    'position:fixed;top:80px;left:8px;z-index:900;padding:6px 12px;' +
    'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
    'font:13px system-ui,sans-serif;cursor:pointer;';
  const formatOptions: ReadonlyArray<readonly [TeamFormat, string]> = [
    ['ffa', 'Free For All'],
    ['2v2', '2v2 Team'],
  ];
  for (const [value, label] of formatOptions) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === format) opt.selected = true;
    formatPicker.appendChild(opt);
  }
  // Reflect format → bot-picker enabled state (greyed + disabled in 2v2 since
  // the count is forced to 3). Applied at init and on every format change.
  const syncBotPicker = (): void => {
    const disabled = format === '2v2';
    botPicker.disabled = disabled;
    botPicker.style.opacity = disabled ? '0.4' : '1';
  };
  formatPicker.addEventListener('change', () => {
    format = parseFormat(formatPicker.value);
    syncBotPicker();
    reset();
  });
  document.body.appendChild(formatPicker);
  syncBotPicker();

  // "Click anywhere to enable sound" hint.
  const soundHint = document.createElement('div');
  soundHint.style.cssText =
    'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:900;' +
    'padding:5px 14px;background:rgba(61,28,2,0.75);color:#f5e6d3;' +
    'font:12px system-ui,sans-serif;border-radius:999px;pointer-events:none;';
  soundHint.textContent = 'Click anywhere to enable sound';
  document.body.appendChild(soundHint);

  // Feel-params panel (hotseat only; see the header comment).
  const feelPanel = new FeelPanel();
  feelPanel.onApply = (next) => {
    feel = next;
    reset();
  };
  document.body.appendChild(feelPanel.root);

  const frame = (now: number): void => {
    const dt = last === undefined ? 0 : Math.min(now - last, MAX_FRAME_MS);
    last = now;
    acc += dt;

    while (acc >= TICK_MS) {
      const inputs: InputFrame[] = [sampleLocalInput(keyboard)];
      for (let slot = 1; slot <= effectiveBots(); slot++) {
        const c = botControllers[slot - 1];
        inputs.push(c ? c.sample(cur, slot) : NO_INPUT);
      }
      const prevTick = cur;
      prev = cur;
      cur = tick(cur, inputs);
      matchSound.tick(prevTick, cur);
      acc -= TICK_MS;
    }

    // Auto-restart: once the match is OVER (last team standing), schedule a
    // fresh random match after ~2.5s. Fires once per match; reset() clears the
    // guard so the next match auto-restarts too.
    if (cur.phase === GamePhase.OVER && !restartScheduled) {
      restartScheduled = true;
      restartTimer = setTimeout(reset, 2500);
    }

    renderer.render(prev, cur, acc / TICK_MS);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const params = new URLSearchParams(window.location.search);
if (params.get('mode') === 'solo') {
  void bootstrapSolo(params);
} else {
  // Default (and ?mode=net) → online lobby.
  void runNetMode(params);
}
