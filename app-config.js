import {t,getLanguage} from './i18n.js?v=feedback1';
// Codex / 2026-10-26. Project path and signaling service are independent.
export const appBaseURL = () => new URL('./', globalThis.location.href);
export const apiURL = path => new URL(path, globalThis.document?.documentElement?.dataset.apiOrigin || globalThis.location.origin).href;
export function inviteURL(room, theme = 'ember') {
  const url = appBaseURL(); url.searchParams.set('theme', theme);
  url.searchParams.set(room.group ? 'group' : 'room', room.roomId); if(typeof window!=='undefined')url.searchParams.set('lang',getLanguage()); return url.href;
}
export function readInvite(value=globalThis.location.href){
  const base=appBaseURL(),url=new URL(value,base);if(url.origin!==base.origin||url.pathname!==base.pathname)throw new Error(t('请使用本站生成的完整房间链接。'));
  const found=[];for(const params of[url.searchParams,new URLSearchParams(url.hash.slice(1))])for(const key of['group','room'])if(params.has(key)){const roomId=params.get(key);if(!/^[A-Za-z0-9_-]{32}$/.test(roomId))throw new Error(t('房间链接格式无效。'));found.push({roomId,group:key==='group'});}
  if(found.some(value=>value.roomId!==found[0].roomId||value.group!==found[0].group))throw new Error(t('房间链接包含多个不同房间。'));return found[0]||null;
}
