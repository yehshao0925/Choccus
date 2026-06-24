/**
 * NetDebugOverlay: DOM panel that makes the M4a transport visible.
 *
 * Shows connection status, the latest RoomState roster, the received
 * MatchStart (seed / slot / config), and a rolling log of the last few
 * InputBroadcast / TickReady / StallNotice / HashMismatch / PlayerDisconnect
 * messages. Debug-only — the real HUD replaces this later.
 */
import type { MatchStartMsg, RoomStateMsg } from './protocolCodec';

const MAX_LOG_LINES = 10;

function section(parent: HTMLElement, title: string): HTMLPreElement {
  const head = document.createElement('div');
  head.textContent = title;
  head.style.cssText = 'margin-top:8px;font-weight:bold;color:#ffd28a;';
  parent.appendChild(head);
  const body = document.createElement('pre');
  body.style.cssText = 'margin:2px 0 0;white-space:pre-wrap;';
  parent.appendChild(body);
  return body;
}

export class NetDebugOverlay {
  readonly root: HTMLDivElement;
  private readonly statusEl: HTMLPreElement;
  private readonly roomEl: HTMLPreElement;
  private readonly matchEl: HTMLPreElement;
  private readonly lockstepEl: HTMLPreElement;
  private readonly logEl: HTMLPreElement;
  private readonly lines: string[] = [];

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:1000',
      'min-width:340px',
      'max-width:480px',
      'padding:10px 12px',
      'background:rgba(46,26,12,0.92)', // dark chocolate
      'color:#f5e6d3',
      'font:12px/1.4 ui-monospace,Menlo,monospace',
      'border-radius:6px',
      'pointer-events:auto',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '奶油啵啵爆 — net status';
    title.style.cssText = 'font-weight:bold;color:#ffb74d;';
    this.root.appendChild(title);

    this.statusEl = section(this.root, 'status');
    this.roomEl = section(this.root, 'room');
    this.matchEl = section(this.root, 'match start');
    this.lockstepEl = section(this.root, 'lockstep');
    this.logEl = section(this.root, `log (last ${MAX_LOG_LINES})`);
    this.setStatus('idle');
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  /** Live lockstep stats (tick / hash / stall / desync), updated per frame. */
  setLockstep(text: string): void {
    this.lockstepEl.textContent = text;
  }

  setRoomState(msg: RoomStateMsg): void {
    const roster = msg.players
      .map(
        (p) =>
          `  slot ${p.slot} ${p.name || '(unnamed)'}` +
          `${p.slot === msg.youSlot ? ' (you)' : ''}` +
          ` — ${p.ready ? 'READY' : 'not ready'}${p.connected ? '' : ' [disconnected]'}`,
      )
      .join('\n');
    this.roomEl.textContent = `room ${msg.roomId} · phase ${msg.phase}\n${roster}`;
  }

  setMatchStart(msg: MatchStartMsg): void {
    this.matchEl.textContent =
      `seed 0x${msg.seed.toString(16).padStart(8, '0')} · you are slot ${msg.slot}` +
      ` · t0 ${msg.t0}\nconfig ${JSON.stringify(msg.config)}`;
  }

  /** Append a line to the rolling log (oldest dropped past MAX_LOG_LINES). */
  log(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines.shift();
    }
    this.logEl.textContent = this.lines.join('\n');
  }
}
