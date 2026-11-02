import {t} from './i18n.js?v=phone1';
// Codex / 2026-10-26. Independent acknowledged chat; forwarding stays in this room.
import {randomId}from'./id.js?v=phone1';
const ID=/^[a-f0-9-]{36}$/i,PEER=/^\d{6}$/;
export class RoomChat {
 constructor(selfId,hooks={},options={}){this.selfId=selfId;this.hooks=hooks;this.peers=new Map();this.channels=new Map();this.seen=new Map();this.pending=new Map();this.history=new Map();this.historyBytes=0;this.historyLimit=options.historyLimit||200;this.ackTimeout=options.ackTimeout||10000;this.disposed=false;}
 get connected(){return [...this.channels].filter(([,entry])=>entry.channel.readyState==='open').map(([id])=>id);}
 updatePeers(peers){this.peers=new Map(peers.map(p=>[p.peerId,p]));for(const id of this.channels.keys())if(!this.peers.has(id))this.remove(id);this.hooks.onChange?.();}
 attach(id,channel){
  this.remove(id);const entry={channel,queue:[]};this.channels.set(id,entry);
  const open=()=>{if(this.channels.get(id)!==entry)return;this.direct(id,{v:1,type:'history-request'});this.hooks.onPeerOpen?.(id);for(const job of this.pending.values())this.flood(job.packet);this.hooks.onChange?.();};
  const message=event=>{if(this.channels.get(id)===entry)this.receive(id,event.data);};
  const close=()=>{if(this.channels.get(id)===entry){this.hooks.onPeerClose?.(id);this.hooks.onChange?.();}};
  channel.addEventListener('open',open);channel.addEventListener('message',message);channel.addEventListener('close',close);
  entry.unbind=()=>{channel.removeEventListener('open',open);channel.removeEventListener('message',message);channel.removeEventListener('close',close);};if(channel.readyState==='open')open();
 }
 remove(id){const entry=this.channels.get(id);entry?.unbind?.();clearTimeout(entry?.timer);this.channels.delete(id);if(entry)this.hooks.onPeerClose?.(id);}
 direct(id,packet){const entry=this.channels.get(id);if(this.disposed||!entry||entry.channel.readyState!=='open'||entry.queue.length>=240)return false;entry.queue.push(JSON.stringify(packet));this.flush(id,entry);return true;}
 flush(id,entry){clearTimeout(entry.timer);if(this.channels.get(id)!==entry||entry.channel.readyState!=='open')return;while(entry.queue.length&&entry.channel.bufferedAmount<131072){try{entry.channel.send(entry.queue[0]);entry.queue.shift();}catch{break;}}if(entry.queue.length)entry.timer=setTimeout(()=>this.flush(id,entry),50);}
 sendControl(id,data){return this.direct(id,{v:1,type:'room-control',data});}
 remember(p){const key=p.from+':'+p.id;if(this.history.has(key))return false;const bytes=new TextEncoder().encode(p.text).length;this.history.set(key,{...p,bytes});this.historyBytes+=bytes;while(this.history.size>this.historyLimit||this.historyBytes>1048576){const key=this.history.keys().next().value;this.historyBytes-=this.history.get(key).bytes;this.history.delete(key);}return true;}
 mark(key){this.seen.set(key,Date.now());while(this.seen.size>512)this.seen.delete(this.seen.keys().next().value);}
 flood(packet,except){if(this.disposed||packet.ttl<=0)return;const data=JSON.stringify(packet);for(const[id,{channel}]of this.channels)if(id!==except&&channel.readyState==='open'&&channel.bufferedAmount<262144)try{channel.send(data);}catch{}}
 acknowledge(p){const ack={v:1,type:'ack',id:p.id,receipt:randomId(),from:this.selfId,to:p.from,ttl:6};this.mark('a:'+ack.receipt);this.flood(ack);}
 receive(via,raw){
  if(this.disposed||!this.peers.has(via)||typeof raw!=='string'||raw.length>70000)return;let p;try{p=JSON.parse(raw);}catch{return;}
  if(p?.v===1&&p.type==='history-request'){for(const {bytes,...message}of this.history.values())this.direct(via,{...message,type:'history-message'});return;}
  if(p?.v===1&&p.type==='room-control'){if(p.data&&typeof p.data==='object')this.hooks.onControl?.(via,p.data);return;}
  if(p?.v===1&&p.type==='history-message'){
   if(!ID.test(p.id)||!PEER.test(p.from)||typeof p.text!=='string'||!p.text.trim()||p.text.length>20000||new TextEncoder().encode(p.text).length>65536||!Number.isSafeInteger(p.at)||p.at<0||p.at>Date.now()+300000||typeof p.label!=='string'||p.label.length>80)return;
   const key='m:'+p.from+':'+p.id;if(this.seen.has(key)||this.history.has(p.from+':'+p.id))return;this.mark(key);this.remember({...p,type:'message',ttl:6});this.hooks.onMessage?.({...p,via,historical:true});return;
  }
  if(p?.v!==1||!ID.test(p.id)||!PEER.test(p.from)||(!this.peers.has(p.from)&&p.from!==this.selfId)||!Number.isInteger(p.ttl)||p.ttl<1||p.ttl>6)return;
  if(p.type==='message'){
   if(typeof p.text!=='string'||!p.text.trim()||p.text.length>20000||new TextEncoder().encode(p.text).length>65536)return;
   const key='m:'+p.from+':'+p.id;if(this.seen.has(key)){if(p.from!==this.selfId&&Date.now()-this.seen.get(key)>400)this.acknowledge(p);return;}
   this.mark(key);p.at=Number.isSafeInteger(p.at)&&p.at>=0&&p.at<=Date.now()+300000?p.at:Date.now();p.label=typeof p.label==='string'&&p.label.length>0&&p.label.length<=80?p.label:this.peers.get(p.from)?.label||'';this.remember(p);if(p.from!==this.selfId){this.hooks.onMessage?.({id:p.id,from:p.from,text:p.text,at:p.at,label:p.label,via,historical:false});this.acknowledge(p);}this.flood({...p,ttl:p.ttl-1},via);
  }else if(p.type==='ack'&&ID.test(p.receipt)&&PEER.test(p.to)&&(p.to===this.selfId||this.peers.has(p.to))){
   const key='a:'+p.receipt;if(this.seen.has(key))return;this.mark(key);
   if(p.to===this.selfId){const job=this.pending.get(p.id);if(job?.targets.has(p.from)){job.delivered.add(p.from);if(job.delivered.size===job.targets.size)this.finish(p.id);}}
   else this.flood({...p,ttl:p.ttl-1},via);
  }
 }
 async sendText(text,identity={}){
  if(this.disposed)throw new Error(t('聊天已结束。'));if(typeof text!=='string'||!text.trim())throw new Error(t('请输入消息。'));if(text.length>20000||new TextEncoder().encode(text).length>65536)throw new Error(t('消息过长，超过本版上限。'));
  if(!this.peers.size||!this.connected.length)throw new Error(t('请等待设备的聊天连接建立。'));if(this.pending.size>=20)throw new Error(t('待发送消息过多，请稍后再试。'));
  const packet={v:1,type:'message',id:identity.id||randomId(),from:this.selfId,text,ttl:6,at:identity.at||Date.now(),label:String(this.hooks.selfLabel?.()||'').slice(0,80)};this.mark('m:'+this.selfId+':'+packet.id);this.remember(packet);
  return new Promise(resolve=>{const job={packet,resolve,targets:new Set(this.peers.keys()),delivered:new Set()};this.pending.set(packet.id,job);job.timer=setTimeout(()=>this.finish(packet.id),this.ackTimeout);job.retry=setTimeout(()=>this.flood(packet),Math.min(2000,this.ackTimeout/2));this.flood(packet);});
 }
 finish(id){const job=this.pending.get(id);if(!job)return;clearTimeout(job.timer);clearTimeout(job.retry);this.pending.delete(id);job.resolve({delivered:job.delivered.size,total:job.targets.size,missing:[...job.targets].filter(id=>!job.delivered.has(id)).map(id=>this.peers.get(id)?.label||t('已离开设备'))});}
 dispose(){this.disposed=true;for(const id of this.pending.keys())this.finish(id);for(const id of this.channels.keys())this.remove(id);this.history.clear();this.historyBytes=0;}
}
