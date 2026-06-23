/**
 * Persistent player identity — the rating key. A random id is generated once
 * and kept in localStorage; the display name stays separate (the name can
 * change, the rating follows the id). No accounts/login: this is the lazy
 * "remember who you are on this device" layer the rating ladder needs.
 */
const KEY = 'choccus.playerId';

export function getPlayerId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (id === null || id === '') {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked (private mode) — anonymous, no persistent rating.
    return '';
  }
}
