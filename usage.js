import {apiURL} from './app-config.js?v=inbox1';
export class UsageReporter {
 constructor(room,{fetcher=globalThis.fetch?.bind(globalThis),url=apiURL,enabled=globalThis.location?.protocol==='https:'}={}){this.room=room;this.fetcher=fetcher;this.url=url;this.enabled=enabled;this.pending=new Set();this.done=new Set();}
 async send(data){
  if(!this.enabled||!this.room?.group)return false;
  const key=JSON.stringify(data);if(this.done.has(key)||this.pending.has(key)||this.done.size>=500)return false;
  this.pending.add(key);
  try{const response=await this.fetcher(this.url('/api/groups/'+this.room.roomId+'/usage'),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.room.token},body:JSON.stringify(data),referrerPolicy:'no-referrer',signal:AbortSignal.timeout(3000)});if(response.ok)this.done.add(key);return response.ok;}catch{return false;}finally{this.pending.delete(key);}
 }
 connection(peerId){void this.send({event:'connection',peerId});}
 fileReceived(id){void this.send({event:'fileReceived',id});}
}
