// Room-only file catalog. Metadata travels over chat DataChannels; bytes use the existing verified file transport.
import {randomId} from './id.js?v=position1';
const HASH=/^[a-f0-9]{64}$/,PEER=/^\d{6}$/,REQUEST=/^[a-f0-9-]{36}$/i;
export class RoomFiles {
 constructor(selfId,hooks={}){this.selfId=selfId;this.hooks=hooks;this.peers=new Set();this.entries=new Map();this.local=new Map();this.pending=new Map();this.serving=new Set();this.disposed=false;}
 send(to,data){if(!this.disposed&&this.peers.has(to))this.hooks.send?.(to,data);}
 valid(m){return m&&HASH.test(m.id)&&PEER.test(m.from)&&typeof m.name==='string'&&m.name.length>0&&m.name.length<=255&&typeof m.label==='string'&&m.label.length<=80&&Number.isSafeInteger(m.size)&&m.size>=0&&m.size<=2147483648&&Number.isSafeInteger(m.at)&&m.at>=0&&m.at<=Date.now()+300000;}
 changed(){this.hooks.onChange?.();}
 connect(id){if(this.disposed||!PEER.test(id))return;this.peers.add(id);this.send(id,{type:'file-sync'});this.changed();}
 disconnect(id){this.peers.delete(id);for(const entry of this.entries.values())entry.holders.delete(id);for(const[key,p]of this.pending)if(p.peer===id)this.finish(key,'unavailable');this.changed();}
 put(meta,holder){let entry=this.entries.get(meta.id);if(!entry){entry={...meta,holders:new Set()};this.entries.set(meta.id,entry);}if(entry.size!==meta.size)return;entry.holders.add(holder);while(this.entries.size>100){const id=this.entries.keys().next().value;this.dropLocal(id);this.entries.delete(id);}}
 metadata(entry){const {holders,...meta}=entry;return meta;}
 addLocal(meta,file){if(this.disposed||!this.valid(meta)||file?.size!==meta.size||typeof file.slice!=='function')return false;this.put(meta,this.selfId);this.local.set(meta.id,file.name===meta.name?file:{name:meta.name,size:file.size,slice:(...args)=>file.slice(...args)});while(this.local.size>20||[...this.local.values()].reduce((n,f)=>n+f.size,0)>4294967296)this.dropLocal(this.local.keys().next().value);if(!this.local.has(meta.id))return false;for(const id of this.peers)this.send(id,{type:'file',file:this.metadata(this.entries.get(meta.id))});this.finish(meta.id);this.changed();return true;}
 dropLocal(id){if(!this.local.delete(id))return;this.entries.get(id)?.holders.delete(this.selfId);for(const peer of this.peers)this.send(peer,{type:'file-withdraw',id});}
 clearLocal(){for(const id of this.local.keys())this.dropLocal(id);this.changed();}
 list(){return [...this.entries.values()].sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)).map(e=>({...this.metadata(e),local:this.local.has(e.id),available:[...e.holders].some(id=>id!==this.selfId&&this.peers.has(id)),pending:this.pending.has(e.id),error:this.errors?.get(e.id)||''}));}
 finish(id,error=''){const pending=this.pending.get(id);clearTimeout(pending?.timer);this.pending.delete(id);this.errors||=new Map();if(error)this.errors.set(id,error);else this.errors.delete(id);this.changed();}
 request(id){const entry=this.entries.get(id),peer=entry&&[...entry.holders].find(id=>id!==this.selfId&&this.peers.has(id));if(this.disposed||!peer||this.local.has(id)||this.pending.has(id))throw Error('unavailable');const request=randomId();this.errors?.delete(id);const timer=setTimeout(()=>this.finish(id,'timeout'),90000);this.pending.set(id,{peer,request,timer});this.send(peer,{type:'file-request',id,request});this.changed();}
 receiving(id){const pending=this.pending.get(id);if(pending){clearTimeout(pending.timer);pending.timer=null;}this.changed();}
 receive(via,p){
  if(this.disposed||!this.peers.has(via)||!p||typeof p!=='object')return;
  if(p.type==='file-sync'){for(const id of this.local.keys())this.send(via,{type:'file',file:this.metadata(this.entries.get(id))});}
  else if(p.type==='file'&&this.valid(p.file)){this.put(p.file,via);this.changed();}
  else if(p.type==='file-withdraw'&&HASH.test(p.id)){this.entries.get(p.id)?.holders.delete(via);if(this.pending.get(p.id)?.peer===via)this.finish(p.id,'unavailable');this.changed();}
  else if(p.type==='file-error'&&HASH.test(p.id)&&this.pending.get(p.id)?.peer===via&&this.pending.get(p.id)?.request===p.request)this.finish(p.id,p.reason==='busy'?'busy':'unavailable');
  else if(p.type==='file-request'&&HASH.test(p.id)&&REQUEST.test(p.request)){
   if(!this.local.has(p.id)||this.serving.has(via)){this.send(via,{type:'file-error',id:p.id,request:p.request,reason:this.local.has(p.id)?'busy':'unavailable'});return;}
   this.serving.add(via);Promise.resolve().then(()=>this.hooks.serve(this.local.get(p.id),via)).catch(()=>this.send(via,{type:'file-error',id:p.id,request:p.request,reason:'busy'})).finally(()=>this.serving.delete(via));
  }
 }
 dispose(){this.disposed=true;for(const p of this.pending.values())clearTimeout(p.timer);this.pending.clear();this.local.clear();this.entries.clear();this.peers.clear();}
}
