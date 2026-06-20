/**
 * LobbyUI: DOM screens for the online flow (M5). Pure view — it renders
 * lobby state and forwards button presses through the on* callbacks; all
 * decisions live in netMode.ts (orchestrator) + NetLobby.ts (state).
 *
 * Screens (one visible at a time, plus two in-match elements):
 *   landing       name + room-code inputs, Create / Join / Quick Match;
 *   room          room code + copy-invite-link, roster, Ready toggle;
 *   disconnected  connection-lost notice + manual Reconnect;
 *   result        post-match Victory/Defeat panel, Rematch / Back to room;
 *   matchNotice   small in-match banner (player disconnected, stall, desync).
 *
 * All visuals are original (plain DOM, chocolate palette) — no copyrighted
 * assets, per the clean-room rules in CLAUDE.md.
 */
import { sfx } from '../audio/Sfx';
import type { RoomStateMsg } from './protocolCodec';

const PALETTE = {
  card: 'rgba(46, 26, 12, 0.96)', // dark chocolate
  text: '#f5e6d3',
  accent: '#ffb74d',
  soft: '#cfb497',
  button: '#6b3f1d',
  buttonHover: '#8a5527',
  primary: '#c87f33',
  danger: '#a3402e',
  input: '#241308',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  parent?.appendChild(node);
  return node;
}

function card(parent: HTMLElement): HTMLDivElement {
  return el(
    'div',
    [
      'display:none',
      'min-width:340px',
      'max-width:420px',
      'padding:24px 28px',
      `background:${PALETTE.card}`,
      `color:${PALETTE.text}`,
      'font:14px/1.5 system-ui,sans-serif',
      'border-radius:14px',
      'box-shadow:0 8px 28px rgba(43,26,14,0.45)',
    ].join(';'),
    parent,
  );
}

function heading(parent: HTMLElement, text: string): HTMLDivElement {
  const h = el(
    'div',
    `font-size:20px;font-weight:bold;color:${PALETTE.accent};margin-bottom:14px;`,
    parent,
  );
  h.textContent = text;
  return h;
}

function button(
  parent: HTMLElement,
  label: string,
  bg: string = PALETTE.button,
): HTMLButtonElement {
  const b = el(
    'button',
    [
      'display:inline-block',
      'margin:4px 8px 4px 0',
      'padding:8px 16px',
      `background:${bg}`,
      `color:${PALETTE.text}`,
      'font:14px system-ui,sans-serif',
      'border:none',
      'border-radius:8px',
      'cursor:pointer',
    ].join(';'),
    parent,
  );
  b.textContent = label;
  b.addEventListener('mouseenter', () => (b.style.filter = 'brightness(1.2)'));
  b.addEventListener('mouseleave', () => (b.style.filter = ''));
  return b;
}

function input(parent: HTMLElement, placeholder: string): HTMLInputElement {
  const i = el(
    'input',
    [
      'display:block',
      'width:100%',
      'box-sizing:border-box',
      'margin:4px 0 12px',
      'padding:8px 10px',
      `background:${PALETTE.input}`,
      `color:${PALETTE.text}`,
      'font:14px system-ui,sans-serif',
      `border:1px solid ${PALETTE.button}`,
      'border-radius:8px',
      'outline:none',
    ].join(';'),
    parent,
  );
  i.placeholder = placeholder;
  return i;
}

function label(parent: HTMLElement, text: string): void {
  const l = el('div', `font-size:12px;color:${PALETTE.soft};`, parent);
  l.textContent = text;
}

export class LobbyUI {
  readonly root: HTMLDivElement;

  // -- orchestrator callbacks --------------------------------------------------
  onCreateRoom?: (name: string) => void;
  onJoinRoom?: (name: string, roomId: string) => void;
  onQuickMatch?: (name: string) => void;
  onReadyToggle?: (ready: boolean) => void;
  onLeaveRoom?: () => void;
  onRematch?: () => void;
  onBackToRoom?: () => void;
  onReconnect?: () => void;
  /** Enter the offline single-player practice mode. */
  onSolo?: () => void;
  /** Build the shareable invite URL for a room id (injected by netMode). */
  buildInviteUrl?: (roomId: string) => string;

  // -- landing ------------------------------------------------------------------
  private readonly landing: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly roomInput: HTMLInputElement;
  private readonly landingStatus: HTMLDivElement;
  private readonly soundToggleBtn: HTMLButtonElement;
  private readonly soundHintEl: HTMLSpanElement;

  // -- room ---------------------------------------------------------------------
  private readonly roomScreen: HTMLDivElement;
  private readonly roomCode: HTMLSpanElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly rosterEl: HTMLDivElement;
  private readonly roomStatus: HTMLDivElement;
  private readonly readyBtn: HTMLButtonElement;
  private localReady = false;
  private currentRoomId = '';

  // -- disconnected ---------------------------------------------------------------
  private readonly discScreen: HTMLDivElement;
  private readonly discMessage: HTMLDivElement;
  private readonly reconnectBtn: HTMLButtonElement;

  // -- result ---------------------------------------------------------------------
  private readonly resultPanel: HTMLDivElement;
  private readonly resultTitle: HTMLDivElement;
  private readonly resultDetail: HTMLDivElement;
  private readonly resultStatus: HTMLDivElement;

  // -- in-match notice --------------------------------------------------------------
  private readonly noticeEl: HTMLDivElement;

  constructor() {
    this.root = el('div', 'display:flex;justify-content:center;');

    // --- landing ---
    // Use a wider card for the polished landing screen.
    this.landing = el(
      'div',
      [
        'display:none',
        'min-width:380px',
        'max-width:460px',
        'padding:32px 34px 28px',
        `background:${PALETTE.card}`,
        `color:${PALETTE.text}`,
        'font:14px/1.5 system-ui,sans-serif',
        'border-radius:18px',
        'box-shadow:0 12px 40px rgba(43,26,14,0.55),0 2px 8px rgba(43,26,14,0.3)',
      ].join(';'),
      this.root,
    );

    // Big "Cocoa Clash" title with chocolate gradient.
    const titleEl = el(
      'div',
      [
        'font-size:38px',
        'font-weight:900',
        'letter-spacing:-1px',
        'margin-bottom:2px',
        'background:linear-gradient(135deg,#FFD700 0%,#F4A460 30%,#D2691E 55%,#8B4513 80%,#3d1c02 100%)',
        '-webkit-background-clip:text',
        '-webkit-text-fill-color:transparent',
        'background-clip:text',
        'line-height:1.1',
      ].join(';'),
      this.landing,
    );
    titleEl.textContent = 'Cocoa Clash';

    // Tagline.
    const taglineEl = el(
      'div',
      `font-size:13px;letter-spacing:2px;color:${PALETTE.soft};margin-bottom:20px;text-transform:uppercase;`,
      this.landing,
    );
    taglineEl.textContent = 'Place. Melt. Escape.';

    // Divider.
    el(
      'div',
      `height:1px;background:linear-gradient(90deg,transparent,${PALETTE.button},transparent);margin-bottom:18px;`,
      this.landing,
    );

    label(this.landing, 'Your name');
    this.nameInput = input(this.landing, 'Player0000');
    this.nameInput.maxLength = 16;
    label(this.landing, 'Room code (leave blank to create a new room)');
    this.roomInput = input(this.landing, 'e.g. QK7PD');
    this.roomInput.maxLength = 16;
    const row = el('div', 'margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;', this.landing);
    button(row, 'Create Room', PALETTE.primary).addEventListener('click', () =>
      this.onCreateRoom?.(this.nameValue()),
    );
    button(row, 'Join Room').addEventListener('click', () =>
      this.onJoinRoom?.(this.nameValue(), this.roomInput.value.trim()),
    );
    button(row, 'Quick Match').addEventListener('click', () =>
      this.onQuickMatch?.(this.nameValue()),
    );
    this.landingStatus = el(
      'div',
      `margin-top:12px;min-height:18px;font-size:13px;color:${PALETTE.soft};`,
      this.landing,
    );

    // Offline single-player practice (vs the lantern spirits).
    const soloRow = el('div', 'margin-top:4px;', this.landing);
    button(soloRow, '🍫 Solo Practice').addEventListener('click', () =>
      this.onSolo?.(),
    );

    // Sound toggle + "click to enable" hint.
    const soundRow = el('div', 'margin-top:16px;display:flex;align-items:center;gap:10px;', this.landing);
    this.soundToggleBtn = el(
      'button',
      [
        'padding:5px 12px',
        `background:${PALETTE.button}`,
        `color:${PALETTE.text}`,
        'border:none',
        'border-radius:8px',
        'font:12px system-ui,sans-serif',
        'cursor:pointer',
      ].join(';'),
      soundRow,
    );
    this.updateSoundBtn();
    this.soundToggleBtn.addEventListener('click', () => {
      sfx.resumeContext();
      sfx.toggleMute();
      this.updateSoundBtn();
      this.soundHintEl.style.display = 'none';
    });
    this.soundHintEl = el(
      'span',
      `font-size:11px;color:${PALETTE.soft};opacity:0.85;`,
      soundRow,
    );
    this.soundHintEl.textContent = 'Click anywhere to enable sound';
    // Hide hint after first click anywhere.
    window.addEventListener('click', () => {
      sfx.resumeContext();
      this.soundHintEl.style.display = 'none';
    }, { once: true });

    // --- room ---
    this.roomScreen = card(this.root);
    heading(this.roomScreen, 'Room');
    const codeRow = el('div', 'margin:-6px 0 12px;', this.roomScreen);
    this.roomCode = el(
      'span',
      `font:bold 26px ui-monospace,Menlo,monospace;letter-spacing:3px;color:${PALETTE.accent};margin-right:12px;`,
      codeRow,
    );
    this.copyBtn = button(codeRow, 'Copy invite link');
    this.copyBtn.addEventListener('click', () => this.copyInviteLink());
    this.rosterEl = el(
      'div',
      'font:13px/1.7 ui-monospace,Menlo,monospace;margin-bottom:10px;',
      this.roomScreen,
    );
    this.roomStatus = el(
      'div',
      `min-height:18px;font-size:13px;color:${PALETTE.soft};margin-bottom:10px;`,
      this.roomScreen,
    );
    this.readyBtn = button(this.roomScreen, 'Ready', PALETTE.primary);
    this.readyBtn.addEventListener('click', () =>
      this.onReadyToggle?.(!this.localReady),
    );
    button(this.roomScreen, 'Leave').addEventListener('click', () =>
      this.onLeaveRoom?.(),
    );

    // --- disconnected ---
    this.discScreen = card(this.root);
    heading(this.discScreen, 'Disconnected');
    this.discMessage = el('div', 'margin-bottom:14px;', this.discScreen);
    this.reconnectBtn = button(this.discScreen, 'Reconnect', PALETTE.primary);
    this.reconnectBtn.addEventListener('click', () => this.onReconnect?.());

    // --- result panel (fixed overlay above the canvas) ---
    this.resultPanel = el(
      'div',
      [
        'display:none',
        'position:fixed',
        'top:50%',
        'left:50%',
        'transform:translate(-50%,-50%)',
        'z-index:1200',
        'min-width:300px',
        'padding:22px 26px',
        `background:${PALETTE.card}`,
        `color:${PALETTE.text}`,
        'font:14px/1.5 system-ui,sans-serif',
        'border-radius:14px',
        'box-shadow:0 8px 28px rgba(43,26,14,0.55)',
        'text-align:center',
      ].join(';'),
    );
    this.resultTitle = el(
      'div',
      `font-size:24px;font-weight:bold;color:${PALETTE.accent};margin-bottom:6px;`,
      this.resultPanel,
    );
    this.resultDetail = el('div', 'margin-bottom:12px;', this.resultPanel);
    const resultRow = el('div', '', this.resultPanel);
    button(resultRow, 'Rematch', PALETTE.primary).addEventListener('click', () =>
      this.onRematch?.(),
    );
    button(resultRow, 'Back to room').addEventListener('click', () =>
      this.onBackToRoom?.(),
    );
    this.resultStatus = el(
      'div',
      `margin-top:10px;min-height:18px;font-size:13px;color:${PALETTE.soft};`,
      this.resultPanel,
    );
    document.body.appendChild(this.resultPanel);

    // --- in-match notice pill ---
    this.noticeEl = el(
      'div',
      [
        'display:none',
        'position:fixed',
        'top:10px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:1100',
        'padding:6px 14px',
        `background:${PALETTE.danger}`,
        `color:${PALETTE.text}`,
        'font:13px system-ui,sans-serif',
        'border-radius:999px',
        'box-shadow:0 4px 14px rgba(43,26,14,0.4)',
      ].join(';'),
    );
    document.body.appendChild(this.noticeEl);
  }

  // -- input access ----------------------------------------------------------------

  setName(name: string): void {
    this.nameInput.value = name;
  }

  setRoomId(roomId: string): void {
    this.roomInput.value = roomId;
  }

  private nameValue(): string {
    return this.nameInput.value.trim() || 'Player';
  }

  private updateSoundBtn(): void {
    this.soundToggleBtn.textContent = sfx.muted ? '🔇 Muted' : '🔊 Sound On';
  }

  // -- screens ------------------------------------------------------------------------

  showLanding(status: string = ''): void {
    this.showOnly(this.landing);
    this.landingStatus.textContent = status;
  }

  setLandingStatus(status: string): void {
    this.landingStatus.textContent = status;
  }

  /** Show/refresh the room view from a RoomState snapshot. */
  showRoom(state: RoomStateMsg): void {
    this.showOnly(this.roomScreen);
    this.currentRoomId = state.roomId;
    this.roomCode.textContent = state.roomId;

    this.rosterEl.textContent = '';
    for (const p of state.players) {
      const line = el('div', '', this.rosterEl);
      const you = p.slot === state.youSlot ? ' (you)' : '';
      const status = !p.connected
        ? 'disconnected'
        : p.ready
          ? 'READY'
          : 'not ready';
      line.textContent = `P${p.slot + 1}  ${p.name || '(unnamed)'}${you} — ${status}`;
      line.style.color =
        p.connected && p.ready ? PALETTE.accent : PALETTE.text;
    }

    this.localReady =
      state.players.find((p) => p.slot === state.youSlot)?.ready ?? false;
    this.readyBtn.textContent = this.localReady ? 'Cancel ready' : 'Ready';
    this.readyBtn.style.background = this.localReady
      ? PALETTE.button
      : PALETTE.primary;

    const present = state.players.filter((p) => p.connected);
    this.roomStatus.textContent =
      present.length < 2
        ? 'Waiting for players… share the invite link! (2+ players to start)'
        : present.every((p) => p.ready)
          ? 'Everyone ready — starting…'
          : 'Waiting for everyone to ready up…';
  }

  showDisconnected(message: string, showRetry: boolean): void {
    this.showOnly(this.discScreen);
    this.discMessage.textContent = message;
    this.reconnectBtn.style.display = showRetry ? '' : 'none';
  }

  /** Hide every lobby screen and panel (the match canvas takes over). */
  showMatch(): void {
    this.showOnly(null);
    this.hideResult();
  }

  // -- in-match elements -----------------------------------------------------------

  setMatchNotice(text: string | null): void {
    if (text === null || text === '') {
      this.noticeEl.style.display = 'none';
    } else {
      this.noticeEl.style.display = 'block';
      this.noticeEl.textContent = text;
    }
  }

  showResult(result: 'win' | 'loss' | 'draw', detail: string): void {
    this.resultPanel.style.display = 'block';
    this.resultTitle.textContent =
      result === 'win' ? 'Victory!' : result === 'draw' ? 'Draw' : 'Defeat';
    this.resultTitle.style.color = result === 'win' ? PALETTE.accent : PALETTE.soft;
    this.resultDetail.textContent = detail;
    this.resultStatus.textContent = '';
  }

  setResultStatus(text: string): void {
    this.resultStatus.textContent = text;
  }

  hideResult(): void {
    this.resultPanel.style.display = 'none';
  }

  // -- helpers ------------------------------------------------------------------------

  private showOnly(screen: HTMLDivElement | null): void {
    for (const s of [this.landing, this.roomScreen, this.discScreen]) {
      s.style.display = s === screen ? 'block' : 'none';
    }
    if (screen !== null) this.hideResult();
  }

  private copyInviteLink(): void {
    const url =
      this.buildInviteUrl?.(this.currentRoomId) ?? window.location.href;
    const flash = (text: string): void => {
      const prior = this.copyBtn.textContent;
      this.copyBtn.textContent = text;
      setTimeout(() => (this.copyBtn.textContent = prior), 1500);
    };
    if (navigator.clipboard?.writeText !== undefined) {
      navigator.clipboard.writeText(url).then(
        () => flash('Copied!'),
        () => window.prompt('Copy this invite link:', url),
      );
    } else {
      window.prompt('Copy this invite link:', url);
    }
  }
}
