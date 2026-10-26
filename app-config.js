// Codex / 2026-10-26. Project path and signaling service are independent.
export const appBaseURL = () => new URL('./', globalThis.location.href);
export const apiURL = path => new URL(path, globalThis.document?.documentElement?.dataset.apiOrigin || globalThis.location.origin).href;
export function inviteURL(room, theme = 'ember') {
  const url = appBaseURL(); url.searchParams.set('theme', theme);
  url.hash = (room.group ? 'group=' : 'room=') + room.roomId; return url.href;
}
