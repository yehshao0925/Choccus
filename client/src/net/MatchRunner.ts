/**
 * MatchRunner: runs ONE online match (M5) — owns the LockstepEngine, the
 * rAF render loop and the keyboard attachment for that match's lifetime.
 * Constructed on MatchStart, stop()ped when the match is torn down (rematch,
 * disconnect, back to lobby). The Renderer and NetClient are long-lived and
 * passed in.
 *
 * - onOver fires exactly once when the sim phase reaches OVER (the engine
 *   keeps rendering the frozen end state until stop()).
 * - onStatus fires every frame with the engine's LockstepStatus (drives the
 *   debug overlay and the in-match notice pill).
 * - Hidden-tab fallback: rAF stops entirely when a tab is hidden, which
 *   would stall the whole lockstep room, so a 250 ms interval keeps pumping
 *   the engine while hidden (browsers throttle it to ~1 Hz — the hidden tab
 *   limps along in bursts and the visible tab sees periodic stalls).
 */
import { GamePhase } from '../../../shared/types';
import { matchSound } from '../audio/MatchSound';
import { sfx } from '../audio/Sfx';
import { KeyboardInput } from '../input/KeyboardInput';
import { sampleLocalInput } from '../input/InputMapper';
import type { Renderer } from '../render/Renderer';
import type { SimState } from '../sim/Sim';
import { resolveOutcome } from '../sim/Outcome';
import { LockstepEngine, type LockstepStatus } from './LockstepEngine';
import type { NetClient } from './NetClient';
import type { MatchStartMsg } from './protocolCodec';

export interface MatchRunnerOptions {
  client: NetClient;
  start: MatchStartMsg;
  /** Slot count = highest occupied slot + 1 at MatchStart (see netMode). */
  numPlayers: number;
  renderer: Renderer;
  /** Long-lived; attached to window for the match, detached on stop(). */
  keyboard: KeyboardInput;
  /** Fired once when the sim reaches OVER (win/loss for your team, or a draw). */
  onOver?: (result: 'win' | 'loss' | 'draw', finalState: SimState) => void;
  /** Fired every animation frame. */
  onStatus?: (status: LockstepStatus) => void;
}

export class MatchRunner {
  readonly engine: LockstepEngine;
  private readonly opts: MatchRunnerOptions;
  private rafId = 0;
  private readonly bgPump: ReturnType<typeof setInterval>;
  private last: number | undefined;
  private stopped = false;
  private overFired = false;
  private readonly muteBtn: HTMLButtonElement;

  constructor(opts: MatchRunnerOptions) {
    this.opts = opts;
    opts.keyboard.attach(window);

    // Mute toggle button (fixed top-right, above the canvas).
    this.muteBtn = document.createElement('button');
    this.muteBtn.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:900;padding:6px 12px;' +
      'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
      'font:13px system-ui,sans-serif;cursor:pointer;';
    const updateMuteBtn = (): void => {
      this.muteBtn.textContent = sfx.muted ? '🔇 Muted' : '🔊 Sound On';
    };
    updateMuteBtn();
    this.muteBtn.addEventListener('click', () => {
      sfx.toggleMute();
      updateMuteBtn();
    });
    document.body.appendChild(this.muteBtn);

    // Resume audio context on first keyboard input.
    window.addEventListener('keydown', () => sfx.resumeContext(), { once: true });
    window.addEventListener('click', () => sfx.resumeContext(), { once: true });

    this.engine = new LockstepEngine({
      client: opts.client,
      start: opts.start,
      numPlayers: opts.numPlayers,
      // In net mode you control your own player with the arrow keys (WASD
      // also works) and Space to drop a bomb, regardless of assigned slot.
      sampleLocalInput: () => sampleLocalInput(opts.keyboard),
    });

    this.rafId = requestAnimationFrame(this.frame);
    this.bgPump = setInterval(() => {
      if (document.visibilityState === 'hidden' && !this.stopped) {
        this.pump(performance.now());
      }
    }, 250);
  }

  private pump(now: number): void {
    const dt = this.last === undefined ? 0 : now - this.last;
    this.last = now;
    this.engine.update(dt);
  }

  private readonly frame = (now: number): void => {
    if (this.stopped) return;
    const { prev: prevBefore } = this.engine.getRenderStates();
    this.pump(now);
    const { prev, next, alpha } = this.engine.getRenderStates();
    // Drive SFX: diff the state that was rendered last frame against the new state.
    if (prevBefore.tick !== next.tick) {
      matchSound.tick(prevBefore, next);
    }
    this.opts.renderer.render(prev, next, alpha);
    this.opts.onStatus?.(this.engine.getStatus());
    if (!this.overFired && next.phase === GamePhase.OVER) {
      this.overFired = true;
      // PvP: resolve the winning team (last team standing, or — at the time cap
      // — most survivors → item tiebreak → draw), then map it to your team.
      const me = next.players.find((p) => p.slot === this.opts.start.slot);
      const { winnerTeam } = resolveOutcome(next);
      const result: 'win' | 'loss' | 'draw' =
        winnerTeam === null
          ? 'draw'
          : me !== undefined && winnerTeam === me.team
            ? 'win'
            : 'loss';
      this.opts.onOver?.(result, next);
    }
    this.rafId = requestAnimationFrame(this.frame);
  };

  /** Tear the match down (idempotent); the socket stays open. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.rafId);
    clearInterval(this.bgPump);
    this.engine.stop();
    this.opts.keyboard.detach(window);
    this.muteBtn.remove();
  }
}
