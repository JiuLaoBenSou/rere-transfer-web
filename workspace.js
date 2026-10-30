import {UsageReporter} from './usage.js?v=usage3';
import {drawQR} from './vendor/reference/qr.js?v=usage3';
import {t,initPage,getLanguage} from './i18n.js?v=usage3';
// Codex / 2026-10-25. Local controller. File/text bytes use the DataChannel only.
import { TransferSession, MAX_FILE } from './transfer.js?v=usage3';
import { TransferRate, formatRate } from './transfer-rate.js?v=usage3';
import { ReceiverStore } from './receiver-store.js?v=usage3';
import { RoomLink, CONNECTION_BUILD } from './room-link.js?v=usage3';
import { GroupLink } from './group-link.js?v=usage3';
import { RoomTransfers } from './room-transfers.js?v=usage3';
import { createTransferMark } from './transfer-mark.js?v=usage3';
import { apiURL, inviteURL, readInvite } from './app-config.js?v=usage3';
import { deviceLabel, DeviceProfile } from './device-profile.js?v=usage3';
import { RoomChat } from './room-chat.js?v=usage3';
initPage();
const $ = selector => document.querySelector(selector);
// Internal tools are opt-in; ordinary invitations never carry this flag.
const debugMode = new URL(location.href).searchParams.get('debug') === '1';
$('#copy-diagnostics').hidden = !debugMode;
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
$('#network-note').textContent = loopback ? t('当前是本机预览，其他设备无法访问此地址。') : t('手机和电脑连接同一局域网，用配对码或扫码加入同一房间；网络隔离可能阻止直连。');
$('#qr-note').textContent = loopback ? t('当前二维码仅供本机预览，手机无法访问。') : t('用同一局域网下的手机扫码。请保持电脑上的页面打开。');
$('#invite-label').textContent = loopback ? t('在本机另一个浏览器窗口打开此链接') : t('在另一台设备打开此链接，或用手机扫码');
const store = new ReceiverStore();
const profile = new DeviceProfile();
const state = { room: null, link: null, session: null, chat: null, chatBusy: false, connected: false, busy: false, roomBusy: false, files: [], autoSendPending: false, urls: new Map(), qrUrl: null, stopQueue: false, remote: null, chatQueue: [], currentChat: null, unread: 0 };
window.canChangeLanguage = () => !state.busy && !state.session?.incoming;
const ROOM_CACHE = 'rere-room-v1';
const targets = new Set(), deviceResults = new Map(), knownPeers = new Set();
const sendRates = new Map(), receiveRates = new Map();
function renderRates() {
  $('#send-rates').replaceChildren(...[...sendRates.values()].map(entry => {
    const value = entry.meter.snapshot();
    return textElement('p', entry.name + ' · ' + (entry.active ? formatRate(value.rate) : t('本次均速 ') + formatRate(value.average)) +
      t(' · 传输 ') + value.elapsed.toFixed(1) + t(' 秒 · 准备 ') + entry.prepare.toFixed(1) + t(' 秒'), 'receipt');
  }));
  for (const [id, entry] of receiveRates) {
    const node = inboxNode(id)?.querySelector('p');
    if (node) node.textContent = t('正在接收 ') + formatBytes(entry.bytes) + ' / ' + formatBytes(entry.total) + ' · ' + formatRate(entry.meter.snapshot().rate);
  }
}
// Refresh while stalled too, so the last nonzero speed does not stay on screen.
setInterval(() => { if ([...sendRates.values()].some(entry => entry.active) || receiveRates.size) renderRates(); }, 500);
const roomPath = room => '/api/' + (room.group ? 'groups' : 'rooms') + '/' + room.roomId;
const themes = ['warm', 'minimal', 'studio', 'privacy', 'bold', 'ember'];
let transferMark;
const formatBytes = bytes => bytes === 0 ? t('0 字节') : bytes < 1024 ? bytes + t(' 字节') : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KiB' : bytes < 1073741824 ? (bytes / 1048576).toFixed(1) + ' MiB' : (bytes / 1073741824).toFixed(1) + ' GiB';
function setTheme(theme) {
  const value = theme === 'ghibli' ? 'ember' : themes.includes(theme) ? theme : 'ember';
  document.body.dataset.theme = value; $('#theme-select').value = value; transferMark?.refresh();
  const url = new URL(location.href); url.searchParams.set('theme', value); history.replaceState(history.state, '', url);
}
setTheme(new URL(location.href).searchParams.get('theme'));
transferMark = createTransferMark($('#transfer-mark'));
$('#theme-select').addEventListener('change', event => setTheme(event.target.value));
function error(message = '') { $('#room-error').textContent = t(message); $('#room-error').hidden = !message; }
function connection(label, connected = false, failed = false) {
  state.connected = connected; transferMark.setConnected(connected);
  $('#connection-label').textContent = label;
  $('#connection-label').classList.toggle('connected', connected); $('#connection-label').classList.toggle('failed', failed); controls();
}
let autoSendScheduled = false;
function fileRecipientsReady() {
  if (!state.connected || !state.session) return false;
  // An unavailable peer must not hold up delivery to other selected devices.
  return !state.room?.group || [...targets].some(id => state.session.connected.includes(id));
}
function scheduleAutoSend() {
  if (!state.autoSendPending || state.busy || autoSendScheduled || !fileRecipientsReady()) return;
  autoSendScheduled = true;
  // Connection and capability callbacks can render repeatedly in the same turn.
  queueMicrotask(() => {
    autoSendScheduled = false;
    if (state.autoSendPending && !state.busy && fileRecipientsReady()) sendQueue();
  });
}
function controls() {
  $('#create-room').disabled = state.roomBusy || !!state.room;
  $('#join-form button').disabled = state.roomBusy || !!state.room; $('#join-link').disabled = state.roomBusy || !!state.room;
  $('#pair-form button').disabled = state.roomBusy || !!state.room; $('#pair-code').disabled = state.roomBusy || !!state.room;
  $('#refresh-pair-code').disabled = state.roomBusy;
  $('#retry-files').hidden = !state.files.some(item => ['failed', 'cancelled'].includes(item.status));
  $('#retry-files').disabled = !fileRecipientsReady() || state.busy;
  const chatReady = state.room?.group ? !!state.chat?.connected.length : state.connected && !state.busy;
  $('#send-text').disabled = !chatReady || !$('#text-draft').value.trim().length || state.chatQueue.length >= 20;
  $('#files').disabled = state.busy; $('#clear-files').disabled = state.busy; $('#text-draft').disabled = false;
  $('#cancel-send').hidden = !state.busy; $('#language-select').disabled = state.busy || !!state.session?.incoming;
  $('#reconnect').disabled = !state.room || (state.room.group ? !(state.link?.members || []).some(p => { const edge=state.link.edges.get(p.peerId); return !edge?.connected || (edge.room.chat && edge.chatChannel?.readyState !== 'open'); }) : state.connected);
  document.querySelectorAll('.device-row input').forEach(input => { input.disabled = state.busy; });
  const pending = state.files.some(item => item.status !== 'done');
  $('#file-send-hint').textContent = state.busy ? t('文件传输中，可随时停止。')
    : pending && !state.autoSendPending ? t('未完成的文件请点击「重试未完成」。')
    : !state.room ? t('请先创建或加入房间；已选文件将在连接后自动发送。')
    : state.room.group && !targets.size ? t('请勾选接收设备；已选文件将在连接后自动发送。')
    : !fileRecipientsReady() ? t('等待所选设备连接；连接后自动发送已选文件。')
    : !state.files.length ? t('拖入或选择文件，自动发送给勾选的设备。')
    : pending ? t('即将自动发送…') : t('已发送完成。重新选择文件可再次发送。');
  $('#text-send-hint').textContent = !chatReady ? (state.room ? t('等待连接…') : t('连接另一台设备，开始聊天。')) : t('Enter 发送 · Shift+Enter 换行');
  scheduleAutoSend();
}
async function api(route, { method = 'GET', data, auth = true, keepalive = false } = {}) {
  const response = await fetch(apiURL(route), { method, headers: { 'Content-Type': 'application/json', ...(auth && state.room ? { Authorization: 'Bearer ' + state.room.token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data), keepalive });
  if (!response.ok) { const json = await response.json().catch(() => ({})); throw Object.assign(new Error(t(json.error) || t('连接服务暂时不可用，请重试。')), { status: response.status }); }
  return response;
}
function textElement(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function renderFiles() {
  $('#file-list').replaceChildren();
  const labels = { pending: t('待发送'), sending: t('发送中'), done: t('已接收 ✓'), failed: t('未完成'), cancelled: t('已停止') };
  for (const item of state.files) {
    const li = document.createElement('li'); li.dataset.status = item.status;
    const title = textElement('span', item.file.name); title.title = item.reason || item.file.name;
    li.append(title, textElement('span', formatBytes(item.file.size) + ' · ' + labels[item.status], 'file-state')); $('#file-list').append(li);
  }
  const done = state.files.filter(item => item.status === 'done').length;
  $('#queue-summary').textContent = state.files.length ? done + ' / ' + state.files.length + t(' 个文件已接收') : '';
  $('#file-actions').hidden = !state.files.length; controls();
}
function selected(files) {
  if (state.busy) return;
  $('.send-feedback').hidden = true; $('#send-status').textContent = ''; $('#send-progress').value = 0;
  const list = Array.from(files);
  state.autoSendPending = false; state.files = []; renderFiles();
  if (list.length > 20) { error(t('一次最多选择 20 个文件。')); return; }
  if (list.some(file => file.size > MAX_FILE)) { error(t('单文件超过本版 2 GiB 上限，请选择较小的文件。')); return; }
  error(); state.files = list.map(file => ({ file, status: 'pending' })); state.autoSendPending = list.length > 0; renderFiles();
}
$('#files').addEventListener('change', () => {
  const files = Array.from($('#files').files);
  // Native pickers otherwise omit change when the identical file is selected again.
  $('#files').value = ''; selected(files);
});
$('#clear-files').addEventListener('click', () => { $('#files').value = ''; selected([]); });
for (const type of ['dragenter', 'dragover']) $('#drop-zone').addEventListener(type, event => { event.preventDefault(); if (!state.busy) $('#drop-zone').classList.add('drag-over'); });
for (const type of ['dragleave', 'drop']) $('#drop-zone').addEventListener(type, event => { event.preventDefault(); $('#drop-zone').classList.remove('drag-over'); if (type === 'drop') selected(event.dataTransfer.files); });
$('#text-draft').addEventListener('input', () => { $('#text-count').textContent = $('#text-draft').value.length.toLocaleString('zh-CN') + ' / 20,000'; controls(); });
$('#clear-text').addEventListener('click', () => { $('#text-draft').value = ''; $('#text-draft').dispatchEvent(new Event('input')); });
$('#text-draft').addEventListener('keydown', event => { if (!event.isComposing && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#send-text').click(); } });
function sendStatus(message) { $('.send-feedback').hidden = false; $('#send-status').textContent = message; if (!message.startsWith(t('正在发送 '))) transferMark.reset(); }
async function sending(task) {
  if (!state.connected || !state.session || state.busy) return;
  const session = state.session; state.busy = true; state.stopQueue = false; controls(); $('#send-progress').value = 0; $('#send-progress').hidden = true;
  try { await task(session); } catch (e) { sendStatus(e.message); $('#send-progress').hidden = true; }
  finally { state.busy = false; renderFiles(); pumpChat(); }
}
function sendQueue() {
  if (state.busy || !fileRecipientsReady()) return;
  // One selection authorizes one attempt; errors and cancellation require retry.
  state.autoSendPending = false;
  const recipients = [...targets];
  sending(async session => {
    for (const item of state.files) {
      if (item.status === 'done') continue;
      if (state.stopQueue) break;
      sendRates.clear(); renderRates(); item.status = 'sending'; item.reason = ''; renderFiles();
      try {
        if (state.room?.group) { item.delivered ||= new Set(); await session.sendFile(item.file, recipients, item.delivered); }
        else await session.sendFile(item.file);
        item.status = 'done';
      }
      catch (e) { item.status = state.stopQueue ? 'cancelled' : 'failed'; item.reason = e.message; renderFiles(); throw e; }
      renderFiles();
    }
    sendStatus(state.stopQueue ? t('发送队列已停止。未完成的文件可再次发送。') : t('队列发送完成，对方已接收并校验。'));
  });
}
$('#retry-files').addEventListener('click', sendQueue);
function chatBubble(text, mine = false, sender = t('对方')) {
  $('#chat-empty').hidden = true;
  const item = document.createElement('article'); item.className = 'chat-message ' + (mine ? 'chat-mine' : 'chat-remote');
  const meta = textElement('div', mine ? t('我') : sender, 'chat-meta');
  const time = textElement('time', new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })); meta.append(time);
  item.append(meta, textElement('pre', text, 'received-text'));
  if (mine) item.append(textElement('span', t('等待发送'), 'chat-status'));
  else { const copy = textElement('button', t('复制文字'), 'quiet'); copy.addEventListener('click', () => copyText(text, copy)); item.append(copy); }
  $('#chat-log').append(item); while ($('#chat-log').children.length > 200) $('#chat-log').firstElementChild.remove();
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  return item;
}
async function pumpChat() {
  const session = state.room?.group ? state.chat : state.session;
  if (state.chatBusy || !session || !(state.room?.group ? state.chat.connected.length : state.connected && !state.busy) || !state.chatQueue.length) return;
  const message = state.chatQueue.shift();
  state.chatBusy = !state.room?.group; state.currentChat = message; controls(); message.node.querySelector('.chat-status').textContent = t('发送中…');
  try { const result = await session.sendText(message.text); message.node.querySelector('.chat-status').textContent = result?.total ? (result.delivered === undefined || result.delivered === result.total ? t('已送达 ') + result.total + t(' 台设备') : t('已送达 ') + result.delivered + ' / ' + result.total + t(' 台 · 未送达：') + result.missing.join('、')) : t('已送达'); }
  catch (error) { message.node.querySelector('.chat-status').textContent = t('未送达 · ') + error.message; }
  finally { if (state.chat === session || state.session === session) { state.chatBusy = false; state.currentChat = null; controls(); pumpChat(); } }
}
$('#send-text').addEventListener('click', () => {
  const text = $('#text-draft').value; if ($('#send-text').disabled || !text.trim() || state.chatQueue.length >= 20) return;
  state.chatQueue.push({ text, node: chatBubble(text, true) }); $('#text-draft').value = ''; $('#text-draft').dispatchEvent(new Event('input')); pumpChat(); $('#text-draft').focus();
});
$('#cancel-send').addEventListener('click', () => { state.stopQueue = true; state.session?.cancel(); });
function inboxNode(id) { return document.getElementById('received-' + id); }
function newInboxItem(id) { $('#inbox-empty').hidden = true; const item = document.createElement('article'); item.id = 'received-' + id; item.className = 'received-item'; $('#inbox-list').prepend(item); $('#clear-inbox').hidden = false; return item; }
function onOffer(meta, receivingSession = state.session, peer) {
  if (meta.kind === 'text') return;
  if ($('#file-panel').hidden) { $('#file-unread').hidden = false; $('#file-unread').textContent = t('正在接收文件 · 查看收件箱'); }
  const session = receivingSession, item = newInboxItem(meta.id);
  item.append(textElement('h3', meta.name), textElement('p', formatBytes(meta.size) + t(' · 正在自动接收…')), ...(peer ? [textElement('span', t('来自 ') + peer.label, 'receipt')] : []));
  const stop = textElement('button', t('停止接收'), 'quiet stop-receive');
  stop.addEventListener('click', () => { if (session.incoming?.id === meta.id) session.failIncoming(t('你已停止接收。')); }); item.append(stop);
}
function onReceived(result) {
  const receivedRate = receiveRates.get(result.id)?.meter.finish(); receiveRates.delete(result.id);
  $('#resume-note').textContent = '';
  if (result.kind === 'text') {
    chatBubble(result.text, false, result.sender || t('对方'));
    result.release().catch(error => error.message);
    if ($('#text-panel').hidden) { state.unread++; $('#chat-unread').textContent = t('收到 ') + state.unread + t(' 条新消息 · 查看聊天'); $('#chat-unread').hidden = false; }
    capacity(); return;
  }
  transferMark.reset(); const item = inboxNode(result.id) || newInboxItem(result.id); item.replaceChildren();
  if ($('#file-panel').hidden) { $('#file-unread').hidden = false; $('#file-unread').textContent = t('收到文件 · 查看收件箱'); }
  item.append(textElement('h3', result.kind === 'text' ? t('文字与代码') : result.name));
  if (result.sender) item.append(textElement('span', t('来自 ') + result.sender, 'receipt'));
  if (result.kind === 'file') {
    const url = URL.createObjectURL(result.blob); state.urls.set(result.id, url);
    const link = textElement('a', t('下载文件'), 'button primary download-file'); link.href = url; link.download = result.name; item.append(link);
    item.append(textElement('p', t('接收完成，请下载保存。')));
  } else {
    item.append(textElement('pre', result.text, 'received-text')); const copy = textElement('button', t('复制文字'), 'secondary'); copy.addEventListener('click', () => copyText(result.text, copy)); item.append(copy);
  }
  item.append(textElement('p', formatBytes(result.size) + t(' · SHA-256 已校验') + (receivedRate ? t(' · 平均 ') + formatRate(receivedRate.average) + ' · ' + receivedRate.elapsed.toFixed(1) + t(' 秒') : ''), 'receipt')); capacity();
}
function capacity() {
  $('#capacity-note').textContent = t('本机接收：') + (store.mode === 'disk' ? t('临时磁盘模式') : t('内存模式')) + t(' · 单文件最多 ') + formatBytes(store.maxFile) + t(' · 收件箱 ') + formatBytes(store.retained) + ' / ' + formatBytes(store.maxInbox) + t('，最多 20 条。') + (state.remote ? t(' 对方单文件上限 ') + formatBytes(state.remote.maxFile) + '。' : '');
}
store.ready.then(capacity);
async function clearInbox() {
  if (state.session?.incoming) { error(t('请先完成或停止正在接收的内容。')); return; }
  $('#clear-inbox').disabled = true;
  try {
    for (const url of state.urls.values()) URL.revokeObjectURL(url); state.urls.clear();
    await store.clear(); state.session?.receipts.clear();
    $('#inbox-list').replaceChildren(); $('#inbox-empty').hidden = false; $('#clear-inbox').hidden = true; capacity();
  } catch (e) { error(t('临时存储清理失败：') + e.message); }
  finally { $('#clear-inbox').disabled = false; }
}
$('#clear-inbox').addEventListener('click', clearInbox);
function createSession(peer) {
  let sendEntry, prepareStarted = 0, prepareSeconds = 0;
  const session = new TransferSession(null, {
    onOffer: meta => onOffer(meta, session, peer), onReceived: result => { if(result.kind==='file')state.usage?.fileReceived(result.id); onReceived(peer ? { ...result, sender: peer.label } : result); queueMicrotask(controls); }, onSendStatus: sendStatus,
    onLocalCapabilities: capacity, onRemoteCapabilities: value => { if (peer) renderDevices(); else state.remote = value; capacity(); },
    onPrepareStart: () => { prepareStarted = performance.now(); prepareSeconds = 0; sendEntry = null; },
    onPrepareProgress: (bytes, total) => { prepareSeconds = (performance.now() - prepareStarted) / 1000; sendStatus(t('正在准备校验 ') + Math.round(bytes / total * 100) + '%…'); },
    onSendStart: ({ id, offset }) => {
      if (sendEntry) sendEntry.meter.rebase(offset);
      else { sendEntry = { meter: new TransferRate(offset), name: peer?.label || t('对方'), prepare: prepareSeconds, active: true }; sendRates.set(id, sendEntry); }
      renderRates();
    },
    onSendFinished: () => { if (sendEntry) { sendEntry.active = false; sendEntry.meter.finish(); renderRates(); } },
    onSendProgress: (bytes, total) => { sendEntry?.meter.update(bytes); $('#send-progress').hidden = false; $('#send-progress').value = total ? bytes / total * 100 : 100; sendStatus(t('正在发送 ') + formatBytes(bytes) + ' / ' + formatBytes(total)); transferMark.setProgress(total ? bytes / total : 1, 'send'); },
    onReceiveStart: ({ id, offset, size }) => { $('#language-select').disabled = true; const entry = receiveRates.get(id); if (entry) { entry.meter.rebase(offset); entry.bytes = offset; } else receiveRates.set(id, { meter: new TransferRate(offset), bytes: offset, total: size }); },
    onReceiveProgress: (id, bytes, total) => { const entry = receiveRates.get(id); if (entry) { entry.meter.update(bytes); entry.bytes = bytes; } transferMark.setProgress(total ? bytes / total : 1, 'receive'); },
    onPaused: () => { $('#resume-note').textContent = t('连接暂时中断，页面仍在等待续接。请保持双方页面打开。'); },
    onResumed: ({ offset }) => { $('#resume-note').textContent = t('已恢复连接，从 ') + formatBytes(offset) + t(' 继续。'); },
    onReceiveError: (id, reason) => { receiveRates.delete(id); queueMicrotask(controls); transferMark.reset(); const item = inboxNode(id); if (item) { item.querySelector('.actions')?.remove(); item.querySelector('.stop-receive')?.remove(); const p = item.querySelector('p'); if (p) p.textContent = reason; } capacity(); },
  }, { store, autoAccept: true });
  return session;
}
function renderDevices(peers = state.link?.members || [], edges = state.link?.edges || new Map()) {
  if (!state.room?.group) return;
  $('#devices-panel').hidden = false; $('#self-device').textContent = deviceLabel(state.room) + ' · ' + (state.room.kind || t('浏览器')) + t('（本机）');
  $('#device-count').textContent = (peers.length + 1) + t(' / 6 台设备');
  const live = new Set(peers.map(p => p.peerId)); for (const id of targets) if (!live.has(id)) targets.delete(id);
  const expanded = new Set([...$('#device-list').querySelectorAll('details[open]')].map(node => node.dataset.peer));
  $('#device-list').replaceChildren();
  for (const peer of peers) {
    const edge = edges.get(peer.peerId), ready = !!edge?.connected;
    if(ready)state.usage?.connection(peer.peerId);
    const label = document.createElement('label'); label.className = 'device-row'; label.dataset.peer = peer.peerId;
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = targets.has(peer.peerId); input.disabled = state.busy;
    input.setAttribute('aria-label', t('文件发给') + peer.label);
    input.addEventListener('change', () => { if (input.checked) targets.add(peer.peerId); else targets.delete(peer.peerId); controls(); });
    const detail = textElement('span', deviceResults.get(peer.peerId) || (ready ? t('已直连') : edge?.blocked ? t('未连通 · 可重新连接') : !peer.online ? t('暂时离线 · 等待恢复') : edge?.failedPeer===edge?.pc && edge?.pc ? t('连接失败 · 正在重试') : t('正在直连…')), 'device-status');
    const remote = state.session?.sessions.get(peer.peerId)?.session.remote;
    if (remote) detail.textContent += t(' · 单文件 ') + formatBytes(remote.maxFile);
    label.append(input, textElement('span', peer.label + ' · ' + (peer.kind || t('浏览器'))), detail); $('#device-list').append(label);
    if (debugMode && ((!ready && edge) || edge?.lastError)) {
      const info = document.createElement('details'); info.className = 'peer-diagnostics';
      info.dataset.peer = peer.peerId; info.open = expanded.has(peer.peerId);
      info.append(textElement('summary', peer.label + t(' 的连接诊断')));
      const d = edge.diagnostics || {};
      info.append(textElement('p', t('本机 ') + (state.room.kind || t('浏览器')) + ' → ' + (peer.kind || t('浏览器')) + ' · ICE ' + (d.ice || t('等待')) + t(' · 地址探测 ') + (d.gathering || t('等待')) + t(' · 候选 ') + (d.local ?? t('未知')) + ' / ' + (d.remote ?? t('未知'))));
      info.append(textElement('p', edge.lastError || t('未建立直连。网络隔离或防火墙可能阻止连接；文字可经房间内已连接设备送达，文件需要双方直连。')));
      $('#device-list').append(info);
    }
  }
  const connected = peers.filter(peer => edges.get(peer.peerId)?.connected).length;
  const blocked = peers.length > 0 && peers.every(peer => edges.get(peer.peerId)?.blocked || !peer.online);
  const retrying = peers.some(peer=>{const edge=edges.get(peer.peerId);return edge?.pc&&edge.failedPeer===edge.pc;});
  connection(connected ? t('已直连 {{count}} 台设备', {count:connected}) : blocked ? t('直连未成功') : retrying ? t('正在重新连接…') : peers.length ? t('正在直连…') : t('等待设备加入'), connected > 0, !connected && blocked);
  $('#connection-detail').textContent = '';
  $('#reconnect').disabled = !peers.some(p => { const edge=edges.get(p.peerId); return !edge?.connected || (edge.room.chat && edge.chatChannel?.readyState !== 'open'); });
  if (!connected && peers.length && [...edges.values()].some(edge => edge.blocked)) $('#signal-note').textContent = t('暂时未能连接，请稍后重试。');
}
async function enter(room) {
  profile.remember(room); document.body.classList.add('has-room');
  const resumeId = globalThis.crypto.randomUUID?.() || String(Date.now()) + Math.random();
  try { sessionStorage.setItem(ROOM_CACHE, JSON.stringify({ room, resumeId })); } catch {}
  const pageUrl = new URL(location.href); pageUrl.searchParams.delete('group'); pageUrl.searchParams.delete('room'); pageUrl.hash = (room.group ? 'group=' : 'room=') + room.roomId; history.replaceState({ rereResume: resumeId }, '', pageUrl);
  state.room = room; state.usage = new UsageReporter(room); state.remote = null;
  targets.clear(); deviceResults.clear(); knownPeers.clear();
  state.session = room.group ? new RoomTransfers((id, result) => { deviceResults.set(id, result); renderDevices(); }) : createSession();
  state.chat = room.group ? new RoomChat(room.peerId, { onMessage: message => { const peer = state.link?.members.find(p => p.peerId === message.from); chatBubble(message.text, false, peer?.label || t('房间设备')); }, onChange: () => { controls(); pumpChat(); } }) : null;
  $('#join-link').value = '';
  $('#room-details').hidden = false; $('#invite-link').value = inviteURL(room, document.body.dataset.theme);
  $('#room-limit').textContent = room.group ? t('房间最多 6 台设备。') : t('此房间最多两台设备。');
  $('#leave-room').textContent = room.group && room.role === 'host' ? t('结束房间') : t('退出房间');
  $('#resume-note').textContent = ''; $('#signal-note').textContent = '';
  $('#pair-code').value = '';
  connection(room.role === 'host' ? t('等待另一台设备') : t('正在直连…'));
  if (room.group) state.link = new GroupLink(room, {
    onSelf: self => { Object.assign(state.room, self); profile.remember(state.room); renderPairing(); },
    onChatChannel: (channel, peer) => state.chat?.attach(peer.peerId, channel),
    onChannel: (channel, peer) => { let entry = state.session.sessions.get(peer.peerId); if (!entry) { const session = createSession(peer); state.session.set(peer.peerId, session, peer); entry = state.session.sessions.get(peer.peerId); } entry.session.attachChannel(channel); },
    onMembers: (peers, edges) => { const firstPeers = !knownPeers.size && peers.length; state.chat?.updatePeers(peers.filter(p => p.features?.includes('chat-v1'))); for (const peer of peers) { if (!knownPeers.has(peer.peerId)) { knownPeers.add(peer.peerId); targets.add(peer.peerId); } const entry = state.session.sessions.get(peer.peerId); if (entry) Object.assign(entry.peer, peer); } if (firstPeers) $('#invite-options').open = false; renderDevices(peers, edges); },
    onRemoved: id => { state.session.remove(id); state.chat?.remove(id); deviceResults.delete(id); },
    onConnected: () => { renderDevices(); error(); pumpChat(); },
    onSignaling: online => { $('#signal-note').textContent = online ? '' : t('房间服务暂时断开，正在恢复；已建立的直连仍可继续。'); },
    onRetryError: message => { $('#signal-note').textContent = t(message); },
    onEnded: reason => { cleanup(t('房间已结束')); error(reason); },
  });
  else state.link = new RoomLink(room, {
    onChannel: channel => state.session?.attachChannel(channel),
    onConnecting: () => { if (state.room?.role === 'host' && state.link?.peer) state.room.pairingUsed = true; renderPairing(); connection(t('正在直连…')); },
    onConnected: () => {
      connection(t('已直连'), true); error(); $('#signal-note').textContent = '';
      if (state.room?.role === 'host') state.room.pairingUsed = true; renderPairing();
      pumpChat();
      if ($('#resume-note').textContent.startsWith(t('连接暂时中断'))) $('#resume-note').textContent = t('连接已恢复，继续本次传输。');
    },
    onPaused: () => connection(t('连接中断，正在重连…')),
    onSignaling: online => { $('#signal-note').textContent = online ? '' : t('房间服务暂时断开，正在恢复；已建立的直连仍可继续。'); },
    onRetryError: message => { $('#signal-note').textContent = t(message) + t(' 正在重试。'); },
    onBlocked: message => { connection(t('直连未成功'), false, true); $('#signal-note').textContent = t(message); },
    onPeerLeft: () => { if (state.room?.role === 'host') { state.room.pairingUsed = false; state.room.pairingExpiresAt = 0; } renderPairing(); connection(t('等待另一台设备重新加入')); $('#signal-note').textContent = t('对方已离线，房间保留，可获取新配对码或重新打开邀请链接加入。'); },
    onDiagnostics: value => { $('#connection-detail').textContent = t('连接路径：本机 ') + value.local + t(' · 对方 ') + value.remote + ' · ' + (value.ice === 'connected' || value.ice === 'completed' ? t('已接通') : value.gathering === 'complete' ? t('地址探测完成') : t('正在探测')); },
    onEnded: reason => { cleanup(t('房间已结束')); error(reason); },
  });
  controls(); updateExpiry();
}
function cleanup(label = t('尚未连接')) {
  state.autoSendPending = false;
  state.stopQueue = true;
  for (const item of state.files) if (item.status === 'pending') item.status = 'cancelled';
  document.body.classList.remove('has-room');
  try { sessionStorage.removeItem(ROOM_CACHE); } catch {}
  for (const message of state.chatQueue) message.node.querySelector('.chat-status').textContent = t('未发送 · 房间已结束');
  state.chatQueue = []; state.currentChat = null; state.busy = false; state.chatBusy = false; state.chat?.dispose(); state.chat = null;
  state.room = null; state.link?.dispose(); state.link = null; const session = state.session; state.session = null; session?.dispose();
  state.remote = null; targets.clear(); knownPeers.clear(); deviceResults.clear(); $('#devices-panel').hidden = true; $('#device-list').replaceChildren(); capacity(); $('#room-details').hidden = true; $('#invite-link').value = ''; $('#join-link').value = ''; $('#pair-code').value = ''; connection(label, false, label !== t('尚未连接'));
  if (state.qrUrl) { URL.revokeObjectURL(state.qrUrl); state.qrUrl = null; }
  $('#qr-dialog').close();
  const url = new URL(location.href); url.searchParams.delete('group'); url.searchParams.delete('room'); url.hash = ''; history.replaceState(null, '', url);
}
async function roomAction(action) {
  if (state.roomBusy || state.room) return;
  state.roomBusy = true; error(); controls();
  try {
    if (!window.RTCPeerConnection || !globalThis.crypto?.getRandomValues) throw new Error(t('此浏览器不支持直连传输，请使用新版 Edge、Chrome 或 Safari。'));
    await action();
  } catch (e) { if (state.room) { await api(roomPath(state.room), { method: 'DELETE' }).catch(() => {}); cleanup(); } error(e.message); }
  finally { state.roomBusy = false; controls(); }
}
$('#create-room').addEventListener('click', () => roomAction(async () => enter(await (await api('/api/groups', { method: 'POST', data: {...profile.joinData(),usageMode:new URL(location.href).searchParams.get('stats')==='test'?'test':'production'}, auth: false })).json())));
$('#pair-form').addEventListener('submit', event => {
  event.preventDefault(); const code = $('#pair-code').value.replace(/\s/g, '');
  roomAction(async () => { if (!/^\d{6}$/.test(code)) throw new Error(t('请输入 6 位数字配对码。')); const room = await (await api('/api/pair', { method: 'POST', data: { code, ...profile.pairData(code) }, auth: false })).json(); profile.remember(room, code); await enter(room); });
});
$('#refresh-pair-code').addEventListener('click', async () => {
  if (!state.room || state.room.role !== 'host' || state.roomBusy) return;
  state.roomBusy = true; controls(); error();
  try { Object.assign(state.room, await (await api(roomPath(state.room) + '/pairing-code', { method: 'POST', data: {} })).json()); renderPairing(); }
  catch (failure) { error(failure.message); }
  finally { state.roomBusy = false; controls(); }
});
function renderPairing() {
  if (!state.room) return;
  const host = state.room.role === 'host'; $('#pairing-panel').hidden = !host && !state.room.group;
  if (!host && !state.room.group) return;
  const used = !state.room.group && state.room.pairingUsed, remaining = Math.max(0, Math.ceil((state.room.pairingExpiresAt - Date.now()) / 1000));
  $('#pairing-code').hidden = used || !remaining || !state.room.pairingCode;
  $('#pairing-code').textContent = state.room.pairingCode?.replace(/^(\d{3})(\d{3})$/, '$1 $2') || '';
  $('#pairing-status').textContent = used ? t('已有设备加入，配对码已失效。') : remaining && state.room.pairingCode ? t('有效期 ') + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') + (state.room.group ? t(' · 可供多台设备加入') : t(' · 仅可配对一次')) : host ? t('配对码已过期，请获取新配对码。') : t('配对码已过期，请让房间创建者更新，或使用邀请链接。');
  $('#refresh-pair-code').hidden = !host || used || !!remaining;
}
async function joinInvite(value) {
  const invite = readInvite(value); if (!invite) throw new Error(t('请使用本站生成的完整房间链接。'));
  const {roomId: id, group} = invite;
  await enter(await (await api('/api/' + (group ? 'groups' : 'rooms') + '/' + id + '/join', { method: 'POST', data: group ? profile.joinData(id) : {}, auth: false })).json());
}
$('#rename-device').addEventListener('click', () => { $('#device-name').value = deviceLabel(state.room); $('#name-dialog').showModal(); $('#device-name').focus(); });
$('#name-form').addEventListener('submit', async event => { event.preventDefault(); if (!state.room?.group) return; const label = $('#device-name').value.trim(); try { const result = await (await api(roomPath(state.room) + '/profile', {method:'POST',data:{label}})).json(); Object.assign(state.room,result); profile.setName(result.label); $('#name-dialog').close(); renderDevices(); } catch (failure) { $('#name-error').textContent = t(failure.message); } });
$('#cancel-name').addEventListener('click', () => $('#name-dialog').close());
$('#join-form').addEventListener('submit', event => { event.preventDefault(); roomAction(() => joinInvite($('#join-link').value.trim())); });
$('#leave-room').addEventListener('click', async () => {
  const leaving = state.room; if (!leaving) return;
  try { await api(roomPath(leaving), { method: 'DELETE' }); }
  catch (e) { if (state.room === leaving) error(e.message); return; }
  // The server's closed event may already have cleaned up this room.
  if (state.room === leaving) cleanup();
});
$('#reconnect').addEventListener('click', () => state.link?.reconnect(true));
$('#copy-diagnostics').addEventListener('click', async () => {
  const peers = await Promise.all((state.link?.members || []).map(async peer => {
    const edge = state.link?.edges.get(peer.peerId), d = edge?.diagnostics || {};
    const connectivity=await Promise.race([edge?.inspectConnectivity?.()||Promise.resolve({supported:false}),new Promise(resolve=>setTimeout(()=>resolve({supported:false}),1500))]);
    return { name:peer.label, kind:peer.kind, online:peer.online, connected:!!edge?.connected, blocked:!!edge?.blocked, stage:edge?.pc?.signalingState || 'none', ice:d.ice || 'unknown', gathering:d.gathering || 'unknown', localCandidates:d.local ?? 0, remoteCandidates:d.remote ?? 0, remoteApplied:d.remoteApplied||0,generation:d.generation,localRoutes:d.localRoutes||{},remoteRoutes:d.remoteRoutes||{},candidateErrors:d.candidateErrors||[],connectivity,error:edge?.lastError || '' };
  }));
  const report = { version:'0.8.1',build:CONNECTION_BUILD,diagnosticSchema:2, browser:navigator.userAgent, secureContext:isSecureContext, rtcAvailable:typeof RTCPeerConnection==='function', status:$('#connection-label').textContent, signaling:state.link?.ws?.readyState ?? null, kind:state.room?.kind, peers };
  copyText(JSON.stringify(report,null,2), $('#copy-diagnostics'));
});
function updateExpiry() {
  if (!state.room) return;
  renderPairing();
  const seconds = Math.max(0, Math.ceil((state.room.expiresAt - Date.now()) / 1000));
  $('#room-expiry').textContent = t('房间剩余 ') + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
setInterval(updateExpiry, 1000);
async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); const original = button.textContent; button.textContent = t('已复制'); setTimeout(() => { button.textContent = original; }, 1500); }
  catch { $('#copy-dialog textarea').value = text; $('#copy-dialog').showModal(); $('#copy-dialog textarea').focus(); $('#copy-dialog textarea').select(); }
}
$('#copy-link').addEventListener('click', () => copyText($('#invite-link').value, $('#copy-link')));
$('#show-qr').addEventListener('click', async () => {
  if (!state.room) return;
  try { const canvas = document.createElement('canvas'); await drawQR(canvas, $('#invite-link').value); $('#qr-image').src = canvas.toDataURL('image/png'); $('#qr-dialog').showModal(); }
  catch (e) { error(e.message); }
});
$('#qr-dialog button').addEventListener('click', () => $('#qr-dialog').close()); $('#copy-dialog button').addEventListener('click', () => $('#copy-dialog').close());
window.addEventListener('beforeunload', event => { if (state.busy || state.session?.incoming) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  state.link?.dispose(); state.session?.dispose(); state.chat?.dispose();
  for (const url of state.urls.values()) URL.revokeObjectURL(url); store.dispose().catch(() => {});
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
$('#text-draft').value = ''; $('#files').value = ''; controls();
let inviteRoom; try { inviteRoom = readInvite(location.href)?.roomId; } catch (failure) { error(failure.message); }
let savedRoom;
try { const saved = JSON.parse(sessionStorage.getItem(ROOM_CACHE)); if (saved?.resumeId === history.state?.rereResume && saved?.room?.roomId === inviteRoom && saved.room.expiresAt > Date.now()) savedRoom = saved.room; } catch {}
if (savedRoom) roomAction(async () => {
  state.room = savedRoom;
  try { const restored = await (await api(roomPath(savedRoom) + '/resume', { method: 'POST', data: savedRoom.group ? profile.joinData(savedRoom.roomId) : {} })).json(); state.room = null; await enter(restored); }
  catch (failure) { const invite = location.href; state.room = null; cleanup(); if (failure.status === 401 && savedRoom.role === 'guest') await joinInvite(invite); else throw failure; }
});
else if (inviteRoom) roomAction(() => joinInvite(location.href));
window.addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.slice(1)), id = params.get('group') || params.get('room');
  if (!id) return;
  if (!state.room) roomAction(() => joinInvite(location.href));
  else if (state.room.roomId !== id) error(t('请先退出当前房间，再加入新的房间。'));
});
