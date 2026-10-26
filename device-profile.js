// Codex / 2026-10-26. Browser-local names and room-scoped re-entry credentials.
const KEY='rere-device-profile-v1';
export function deviceKind(nav=globalThis.navigator||{}){
 const ua=nav.userAgent||'',platform=nav.userAgentData?.platform||nav.platform||'';
 if(/iPhone/i.test(ua))return'iPhone';if(/iPad/i.test(ua)||(/Mac/i.test(platform+ua)&&nav.maxTouchPoints>1))return'iPad';
 if(/Android/i.test(ua))return'Android';if(/Win/i.test(platform+ua))return'Windows';if(/Mac/i.test(platform+ua))return'Mac';if(/Linux/i.test(platform+ua))return'Linux';return'浏览器';
}
export class DeviceProfile {
 constructor(storage){if(storage===undefined)try{storage=globalThis.localStorage;}catch{}this.storage=storage;}
 read(){try{const value=JSON.parse(this.storage?.getItem(KEY)||'{}');return value&&typeof value==='object'?value:{};}catch{return{};}}
 save(value){try{this.storage?.setItem(KEY,JSON.stringify(value));}catch{}}
 joinData(roomId){const data=this.read(),room=data.rooms?.[roomId];return{kind:deviceKind(),features:['chat-v1'],...(data.label?{label:data.label}:{}),...(room?.expiresAt>Date.now()?{resumeToken:room.token}:{})};}
 pairData(code){const data=this.read(),entry=data.codes?.[code];return this.joinData(entry?.expiresAt>Date.now()?entry.roomId:undefined);}
 remember(room,code){if(!room?.group&&room?.group!==undefined)return;const data=this.read();data.rooms||={};data.rooms[room.roomId]={token:room.token,expiresAt:room.expiresAt};data.rooms=Object.fromEntries(Object.entries(data.rooms).filter(([,v])=>v.expiresAt>Date.now()).sort((a,b)=>b[1].expiresAt-a[1].expiresAt).slice(0,12));data.codes||={};code||=room.pairingCode;if(code)data.codes[code]={roomId:room.roomId,expiresAt:Math.min(room.pairingExpiresAt||Date.now()+300000,Date.now()+300000)};data.codes=Object.fromEntries(Object.entries(data.codes).filter(([,v])=>v.expiresAt>Date.now()).slice(-12));this.save(data);}
 setName(label){const data=this.read();data.label=label;this.save(data);}
 forget(roomId){const data=this.read();if(data.rooms)delete data.rooms[roomId];this.save(data);}
}
