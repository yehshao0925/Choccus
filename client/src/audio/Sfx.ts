/**
 * Sfx: Web Audio API synthesiser for all in-game sound effects.
 *
 * All sounds are 100% procedurally generated — no external audio files.
 * AudioContext is created lazily on the first call to resumeContext() (called
 * on first user gesture) so browsers never block autoplay.
 *
 * Sound design: "軟黏可愛" candy palette (chocolate / cream / cake theme).
 * Triangle + sine dominant (rounded, music-box bells), noise kept soft & wet
 * (piped cream, sugar crackle), gentle wobbles for charm — nothing buzzy or
 * harsh. Melodic cues (rescue / item / win / lose) are music-box arpeggios.
 *
 * Roster (13 cues):
 *   place · explode · trap · rescue · item · eliminate · win · lose   (match)
 *   count · go                                                        (intro)
 *   fuse · shrinkWarn · crystal                                       (tension)
 *
 * Mute state is persisted in localStorage under the key "choccus_muted".
 * A master GainNode lets every sound honour the mute flag without per-sound
 * branching (gain is set to 0 when muted).
 */

const STORAGE_KEY = 'choccus_muted';

class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _muted: boolean;

  constructor() {
    // Read persisted mute state; default to unmuted.
    const stored = localStorage.getItem(STORAGE_KEY);
    this._muted = stored === 'true';
  }

  // ---------------------------------------------------------------------------
  // Context bootstrap
  // ---------------------------------------------------------------------------

  /** Call once on the first user gesture (click / keydown) to unlock audio. */
  resumeContext(): void {
    if (this.ctx === null) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
    } else if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx === null) return null; // not yet unlocked — silent
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  // ---------------------------------------------------------------------------
  // Mute controls
  // ---------------------------------------------------------------------------

  get muted(): boolean {
    return this._muted;
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    localStorage.setItem(STORAGE_KEY, String(muted));
    if (this.master !== null) {
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx!.currentTime, 0.01);
    }
  }

  /** Toggle mute and return the new state. */
  toggleMute(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create an OscillatorNode + GainNode chain connected to master, already
   * started. Returns [osc, env].
   */
  private osc(
    type: OscillatorType,
    freq: number,
    when: number,
  ): [OscillatorNode, GainNode] {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.connect(this.master!);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.connect(gain);
    o.start(when);
    return [o, gain];
  }

  /**
   * Attach a sine LFO to an oscillator's frequency for a gentle wobble.
   * Returns nothing — the LFO lives until `stop`.
   */
  private wobble(target: OscillatorNode, rateHz: number, depthHz: number, when: number, stop: number): void {
    const ctx = this.ctx!;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rateHz;
    const lg = ctx.createGain();
    lg.gain.value = depthHz;
    lfo.connect(lg);
    lg.connect(target.frequency);
    lfo.start(when);
    lfo.stop(stop);
  }

  /**
   * Create a white-noise buffer source connected through a BiquadFilter to
   * master. Returns [src, filter, env].
   */
  private noise(
    filterType: BiquadFilterType,
    freq: number,
    when: number,
    duration: number,
  ): [AudioBufferSourceNode, BiquadFilterNode, GainNode] {
    const ctx = this.ctx!;
    const bufLen = Math.ceil(ctx.sampleRate * duration) + 1024;
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = freq;

    const env = ctx.createGain();

    src.connect(filt);
    filt.connect(env);
    env.connect(this.master!);
    src.start(when);
    return [src, filt, env];
  }

  // ---------------------------------------------------------------------------
  // Match SFX
  // ---------------------------------------------------------------------------

  /**
   * place() — soft gooey "po" as a chocolate is set down.
   * Rounded sine drop + a tiny triangle bup + a faint wet touch. ~90 ms.
   */
  place(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;

    const [osc, env] = this.osc('sine', 280, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.07);
    env.gain.setValueAtTime(0.32, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.stop(t + 0.1);

    // Soft low bup for body.
    const [o2, e2] = this.osc('triangle', 180, t + 0.005);
    e2.gain.setValueAtTime(0.12, t + 0.005);
    e2.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o2.stop(t + 0.09);

    // Faint wet "set down" touch (rounded lowpass, not a sharp tick).
    const [, , nEnv] = this.noise('lowpass', 600, t, 0.03);
    nEnv.gain.setValueAtTime(0.05, t);
    nEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
  }

  /**
   * explode() — bouncy wet cream squeeze "噗嘰~".
   * Soft low "噗" body + a TRIANGLE squeak that bends up then eases down with a
   * gentle cute wobble + a lowpass-noise "ffff" spray sweeping down. ~0.7 s,
   * noise-dominated so it reads as piped cream, not electronics.
   */
  explode(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const dur = 0.7;

    // Soft squish body "噗".
    const [sub, sEnv] = this.osc('sine', 100, t);
    sub.frequency.exponentialRampToValueAtTime(45, t + 0.3);
    sEnv.gain.setValueAtTime(0.3, t);
    sEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
    sub.stop(t + 0.36);

    // Bouncy cream squeak "嘰~" with a gentle cute wobble.
    const [osc, oEnv] = this.osc('triangle', 150, t);
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.linearRampToValueAtTime(300, t + 0.1);
    osc.frequency.exponentialRampToValueAtTime(110, t + dur);
    this.wobble(osc, 14, 18, t, t + dur);
    oEnv.gain.setValueAtTime(0.0, t);
    oEnv.gain.linearRampToValueAtTime(0.2, t + 0.04);
    oEnv.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.stop(t + dur + 0.02);

    // Wet airy "ffff" spray — bulk of the sound.
    const [, nFilt, nEnv] = this.noise('lowpass', 1600, t, dur);
    nFilt.frequency.setValueAtTime(1600, t);
    nFilt.frequency.exponentialRampToValueAtTime(260, t + dur);
    nFilt.Q.value = 0.7;
    nEnv.gain.setValueAtTime(0.0, t);
    nEnv.gain.linearRampToValueAtTime(0.22, t + 0.04);
    nEnv.gain.exponentialRampToValueAtTime(0.001, t + dur);
  }

  /**
   * trap() — sweet glassy "✨ting" as the sugar shell crystallises.
   * Stacked triangle bells + a quick upward sparkle glissando. ~0.4 s.
   */
  trap(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;

    const bells: [number, number][] = [
      [1568, 0.32], // G6
      [2349, 0.16], // D7
    ];
    for (const [f, g] of bells) {
      const [o, e] = this.osc('triangle', f, t);
      e.gain.setValueAtTime(g, t);
      e.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.stop(t + 0.42);
    }

    // Upward sparkle glissando.
    const [s, sE] = this.osc('sine', 1046, t);
    s.frequency.exponentialRampToValueAtTime(3136, t + 0.18);
    sE.gain.setValueAtTime(0.0, t);
    sE.gain.linearRampToValueAtTime(0.12, t + 0.02);
    sE.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    s.stop(t + 0.22);
  }

  /**
   * rescue() — bright music-box rising arpeggio C5→E5→G5→C6 with octave shimmer.
   */
  rescue(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const start = t + i * 0.07;
      const [osc, env] = this.osc('triangle', freq, start);
      env.gain.setValueAtTime(0.28, start);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      osc.stop(start + 0.18);
      // Soft octave shimmer.
      const [o2, e2] = this.osc('sine', freq * 2, start);
      e2.gain.setValueAtTime(0.06, start);
      e2.gain.exponentialRampToValueAtTime(0.001, start + 0.1);
      o2.stop(start + 0.12);
    });
  }

  /**
   * item() — cute "pi-rin" pickup ding G5 → D6 with a sparkle tail.
   */
  item(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const pairs: [number, number][] = [
      [783.99, t],         // G5
      [1174.66, t + 0.07], // D6
    ];
    for (const [freq, start] of pairs) {
      const [osc, env] = this.osc('triangle', freq, start);
      env.gain.setValueAtTime(0.26, start);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
      osc.stop(start + 0.16);
    }
    // Tiny sparkle tail.
    const [o3, e3] = this.osc('sine', 2349, t + 0.07);
    e3.gain.setValueAtTime(0.08, t + 0.07);
    e3.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o3.stop(t + 0.22);
  }

  /**
   * eliminate() — cartoon sugar-shell crack + a comedic "bo-wop" droop.
   * Soft crackle (not a harsh thud) so KO reads as candy shattering. ~0.3 s.
   */
  eliminate(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;

    // Crisp sugar-shell crackle sweeping down.
    const [, nFilt, nEnv] = this.noise('bandpass', 2000, t, 0.12);
    nFilt.frequency.setValueAtTime(2400, t);
    nFilt.frequency.exponentialRampToValueAtTime(700, t + 0.12);
    nFilt.Q.value = 1.2;
    nEnv.gain.setValueAtTime(0.3, t);
    nEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    // Comedic "bo-wop" droop.
    const [osc, oEnv] = this.osc('triangle', 440, t + 0.04);
    osc.frequency.setValueAtTime(440, t + 0.04);
    osc.frequency.exponentialRampToValueAtTime(130, t + 0.3);
    oEnv.gain.setValueAtTime(0.3, t + 0.04);
    oEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    osc.stop(t + 0.34);
  }

  /**
   * win() — happy music-box fanfare C5→E5→G5→C6→E6 + a final sparkle shimmer.
   */
  win(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51]; // C5 E5 G5 C6 E6
    notes.forEach((freq, i) => {
      const start = t + i * 0.1;
      const [osc, env] = this.osc('triangle', freq, start);
      env.gain.setValueAtTime(0.3, start);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      osc.stop(start + 0.22);
      const [o2, e2] = this.osc('sine', freq * 2, start);
      e2.gain.setValueAtTime(0.07, start);
      e2.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
      o2.stop(start + 0.16);
    });
    // Final sparkle shimmer.
    const [s, sE] = this.osc('triangle', 2637, t + 0.5); // E7
    sE.gain.setValueAtTime(0.14, t + 0.5);
    sE.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    s.stop(t + 0.92);
  }

  /**
   * lose() — comedic-sad droopy descend A4→F4→D4→A3 + a final "bloop" slide.
   */
  lose(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const notes = [440.0, 349.23, 293.66, 220.0]; // A4 F4 D4 A3
    notes.forEach((freq, i) => {
      const start = t + i * 0.14;
      const [osc, env] = this.osc('triangle', freq, start);
      env.gain.setValueAtTime(0.3, start);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.24);
      osc.stop(start + 0.26);
    });
    // Final droopy "bloop" slide under the last note.
    const last = t + 3 * 0.14;
    const [osc, env] = this.osc('sine', 220, last);
    osc.frequency.exponentialRampToValueAtTime(110, last + 0.4);
    env.gain.setValueAtTime(0.28, last);
    env.gain.exponentialRampToValueAtTime(0.001, last + 0.45);
    osc.stop(last + 0.47);
  }

  // ---------------------------------------------------------------------------
  // Intro SFX
  // ---------------------------------------------------------------------------

  /**
   * count(n) — soft music-box "ti" for each intro number (n = 3,2,1).
   * Pitch rises 3→2→1 to build tension. Octave sparkle on top.
   */
  count(n: number): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const base = n >= 3 ? 392 : n === 2 ? 440 : 494; // G4 A4 B4

    const [o, e] = this.osc('triangle', base, t);
    e.gain.setValueAtTime(0.0, t);
    e.gain.linearRampToValueAtTime(0.3, t + 0.01);
    e.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.stop(t + 0.2);

    const [o2, e2] = this.osc('triangle', base * 2, t);
    e2.gain.setValueAtTime(0.0, t);
    e2.gain.linearRampToValueAtTime(0.08, t + 0.01);
    e2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o2.stop(t + 0.12);
  }

  /**
   * go() — bright cheerful "pi-PON!" two-note leap E5→B5 + sparkle. Match start.
   */
  go(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const notes: [number, number][] = [
      [659.25, t],        // E5
      [987.77, t + 0.08], // B5
    ];
    notes.forEach(([f, s], i) => {
      const [o, e] = this.osc('triangle', f, s);
      const peak = i === 1 ? 0.4 : 0.3;
      e.gain.setValueAtTime(0, s);
      e.gain.linearRampToValueAtTime(peak, s + 0.01);
      e.gain.exponentialRampToValueAtTime(0.001, s + 0.22);
      o.stop(s + 0.24);
    });
    // Sparkle tail.
    const [o3, e3] = this.osc('triangle', 1975.5, t + 0.12); // B6
    e3.gain.setValueAtTime(0, t + 0.12);
    e3.gain.linearRampToValueAtTime(0.12, t + 0.13);
    e3.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o3.stop(t + 0.32);
  }

  // ---------------------------------------------------------------------------
  // Tension SFX
  // ---------------------------------------------------------------------------

  /**
   * fuse() — tiny soft "tik", a single anticipatory tick as a bomb nears its
   * melt. Kept quiet so several near-blow bombs blend into tension, not clatter.
   */
  fuse(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const [o, e] = this.osc('triangle', 1100, t);
    e.gain.setValueAtTime(0.0, t);
    e.gain.linearRampToValueAtTime(0.12, t + 0.005);
    e.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.stop(t + 0.06);
  }

  /**
   * shrinkWarn() — sudden-death onset alarm: an ominous-but-cute wavering tone
   * that droops, over a low sub thump for weight. ~0.9 s, fires once per match.
   */
  shrinkWarn(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const dur = 0.9;

    const [o, e] = this.osc('triangle', 330, t);
    o.frequency.setValueAtTime(330, t);
    o.frequency.linearRampToValueAtTime(247, t + dur); // droop down
    this.wobble(o, 7, 22, t, t + dur);
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(0.3, t + 0.05);
    e.gain.setValueAtTime(0.3, t + dur - 0.2);
    e.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.stop(t + dur + 0.02);

    // Low sub thump for weight.
    const [sub, sE] = this.osc('sine', 110, t);
    sub.frequency.exponentialRampToValueAtTime(70, t + 0.3);
    sE.gain.setValueAtTime(0.3, t);
    sE.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    sub.stop(t + 0.42);
  }

  /**
   * crystal() — tiny sugar "ting" as a tile crystallises while the ring closes.
   */
  crystal(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const [o, e] = this.osc('triangle', 2093, t); // C7
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(0.1, t + 0.004);
    e.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.stop(t + 0.14);
  }
}

/** Singleton sfx engine — import and call methods directly. */
export const sfx = new SfxEngine();
