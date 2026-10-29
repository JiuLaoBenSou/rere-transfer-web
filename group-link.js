import {t} from './i18n.js?v=warmdrop1';
// Codex / 2026-10-26. One signaling socket; independent direct links per peer.
import { RoomLink } from './room-link.js?v=warmdrop1';
class PeerLink extends RoomLink {
  listen() {}
  request(action,method,data){return this.owner.request(action,method,{...data,to:this.target.peerId,fromEpoch:this.owner.epoch,toEpoch:this.target.epoch});}
}
export class GroupLink extends RoomLink {
  constructor(room,hooks={}){super({...room,role:'host',peerPresent:false},hooks);this.identity=room;this.edges=new Map();this.members=[];this.epoch=room.epoch;}
  get connected(){return [...(this.edges?.values()||[])].some(edge=>edge.connected);}
  async handle(message){
    if(message.type==='closed')return super.handle(message);
    if(message.type==='members'){
      if(this.epoch!==message.selfEpoch){for(const edge of this.edges.values())edge.dispose();this.edges.clear();}
      this.epoch=message.selfEpoch;this.members=message.peers;
      if(message.self)this.hooks.onSelf?.(message.self);
      for(const[id,edge]of this.edges)if(!this.members.some(p=>p.peerId===id)){edge.dispose();this.edges.delete(id);this.hooks.onRemoved?.(id);}
      for(const peer of this.members){
        let edge=this.edges.get(peer.peerId);
        if(edge&&edge.target.epoch!==peer.epoch){edge.dispose();this.edges.delete(peer.peerId);edge=null;this.hooks.onRemoved?.(peer.peerId);}
        if(!edge&&peer.online){
          const update=()=>this.hooks.onMembers?.(this.members,this.edges);
          edge=new PeerLink({...this.identity,role:this.identity.peerId<peer.peerId?'host':'guest',peerPresent:true,generation:0,chat:!!this.identity.features?.includes('chat-v1')&&!!peer.features?.includes('chat-v1')},{
            onChannel:channel=>this.hooks.onChannel?.(channel,peer),onConnecting:update,
            onChatChannel:channel=>this.hooks.onChatChannel?.(channel,peer),onChatState:update,
            onConnected:()=>{update();this.hooks.onConnected?.();},onPaused:update,onBlocked:update,
            onRetryError:message=>{edge.lastError=message;update();},onDiagnostics:value=>{edge.diagnostics=value;update();},
          });edge.owner=this;edge.target=peer;this.edges.set(peer.peerId,edge);await edge.reconnect();
        }
        if(edge)edge.target=peer;
      }
      this.peer=this.members.length>0;this.hooks.onMembers?.(this.members,this.edges);return;
    }
    const edge=this.edges.get(message.from);
    if(edge&&message.fromEpoch===edge.target.epoch&&message.toEpoch===this.epoch)try{await edge.handle(message);}catch(error){
      const category=['OperationError','InvalidStateError','InvalidAccessError','NotSupportedError','TypeError','AbortError','Error'].includes(error?.name)?error.name:'Error';
      edge.lastError=t('协商 ')+message.type+t(' 失败（')+category+(Number.isInteger(error?.status)?' / HTTP '+error.status:'')+'）';
      this.hooks.onMembers?.(this.members,this.edges);
    }
  }
  async reconnect(force=false){for(const edge of this.edges?.values()||[])if(!edge.connected||(edge.room.chat&&edge.chatChannel?.readyState!=='open'))await edge.reconnect(force);}
  dispose(){for(const edge of this.edges?.values()||[])edge.dispose();this.edges?.clear();super.dispose();}
}
