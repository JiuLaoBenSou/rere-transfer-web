import {t} from './i18n.js?v=usage1';
// Codex / 2026-10-26. Recipient snapshot and per-device completion.
export class RoomTransfers {
  constructor(onResult=()=>{}){this.sessions=new Map();this.onResult=onResult;this.receipts={clear:()=>{for(const {session}of this.sessions.values())session.receipts.clear();}};}
  set(id,session,peer){this.sessions.set(id,{session,peer});}
  get incoming(){return [...this.sessions.values()].find(v=>v.session.incoming)?.session.incoming;}
  get connected(){return [...this.sessions].filter(([,v])=>v.session.channel?.readyState==='open').map(([id])=>id);}
  remove(id){this.sessions.get(id)?.session.dispose();this.sessions.delete(id);}
  async sendFile(file,targets,delivered=new Set()){return this.send('sendFile',file,targets,delivered);}
  async sendText(text){return this.send('sendText',text,this.connected);}
  async send(method,value,targets,delivered=new Set()){
    const ids=[...new Set(targets||[])];if(!ids.length)throw new Error(t('请先选择要接收文件的设备。'));
    const results=await Promise.all(ids.map(async id=>{
      const entry=this.sessions.get(id),label=entry?.peer.label||t('设备 ')+id;
      if(delivered.has(id))return{id,label,ok:true};this.onResult(id,t('正在发送'));
      try{if(entry?.session.channel?.readyState!=='open')throw new Error(t('未连通，请恢复连接后重试'));await entry.session[method](value);delivered.add(id);this.onResult(id,t('已接收 ✓'));return{id,label,ok:true};}
      catch(error){this.onResult(id,t('未完成 · ')+error.message);return{id,label,ok:false,reason:error.message};}
    }));
    const result={delivered:results.filter(r=>r.ok).length,total:ids.length,results};
    if(result.delivered!==result.total)throw Object.assign(new Error(t('已送达 {{delivered}} / {{total}} 台；',result)+results.filter(r=>!r.ok).map(r=>`${r.label}：${r.reason}`).join('；')),{result});return result;
  }
  cancel(){for(const {session}of this.sessions.values())session.cancel();}
  dispose(){for(const {session}of this.sessions.values())session.dispose();this.sessions.clear();}
}
