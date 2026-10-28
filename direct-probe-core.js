// Codex / 2026-10-29. Isolated reference experiment; no RoomLink dependency.
export const MAX_PROBE_FILE = 8 * 1024 * 1024;
const CHUNK = 16 * 1024, INBOX = 16 * 1024 * 1024;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
export function peerOptions(initiator,mode='standard') {
  return {initiator,objectMode:true,trickle:mode!=='complete',config:{iceServers:mode==='lan'?[]:[{urls:'stun:stun.cloudflare.com:3478'}]},channelName:'rere-reference-v1'};
}
export function signalEnvelope(signal) {
  if(signal.candidate && Object.keys(signal).every(k=>k==='candidate'||k==='type'))return{type:'ice',data:signal.candidate};
  if(['offer','answer'].includes(signal.type)&&typeof signal.sdp==='string'&&Object.keys(signal).every(k=>k==='type'||k==='sdp'))return{type:signal.type,data:{type:signal.type,sdp:signal.sdp}};
  throw new Error('仅允许连接协商消息。');
}
export function summarizeStats(items) {
  const map=new Map(items.map(x=>[x.id,x]));const pairs=items.filter(x=>x.type==='candidate-pair');
  const id=items.find(x=>x.type==='transport'&&x.selectedCandidatePairId)?.selectedCandidatePairId;
  const pair=map.get(id)||pairs.find(x=>x.selected||(x.nominated&&x.state==='succeeded'));
  const route=id=>{const x=map.get(id);return x?`${x.candidateType||'unknown'}/${x.protocol||'unknown'}`:'unknown';};
  // Missing reports/counters are unknown, not proof of zero traffic.
  const total=key=>pairs.length&&pairs.every(x=>Number.isFinite(x[key]))?pairs.reduce((n,x)=>n+x[key],0):null;
  return{pairs:pairs.reduce((r,x)=>(r[x.state]=(r[x.state]||0)+1,r),{}),requestsSent:total('requestsSent'),responsesReceived:total('responsesReceived'),selected:pair?{local:route(pair.localCandidateId),remote:route(pair.remoteCandidateId),bytesSent:pair.bytesSent??null,bytesReceived:pair.bytesReceived??null}:null};
}

function candidateRoute(candidate='') {
  const fields=candidate.replace(/^a=/,'').trim().split(/\s+/),address=fields[4]||'';
  const type=['host','srflx','prflx','relay'].includes(fields[7])?fields[7]:'unknown';
  const protocol=['udp','tcp'].includes(fields[2]?.toLowerCase())?fields[2].toLowerCase():'unknown';
  const privateV4=/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  const space=address.endsWith('.local')?'mdns':address.includes(':')?'ipv6':/^\d+\.\d+\.\d+\.\d+$/.test(address)?(privateV4?'private-ipv4':'other-ipv4'):'unknown';
  return `${type}/${protocol}/${space}`;
}
const safeError=error=>['OperationError','InvalidStateError','InvalidAccessError','NotSupportedError','NotAllowedError','TypeError'].includes(error?.name)?error.name:'Error';

// A bounded, in-memory journal. No raw addresses, SDP, room tokens or file data.
export class ProbeEvidence {
  constructor(clock=()=>performance.now()) {
    this.clock=clock;this.started=clock();this.sequence=0;this.accepted=0;this.pending=new Set();
    this.data={latest:null,lastWithPairs:null,samples:[],events:[],operations:{},descriptions:{},localCandidates:{},candidateErrors:[]};
  }
  elapsed(){return Math.max(0,Math.round(this.clock()-this.started));}
  begin(){return {sequence:++this.sequence,atMs:this.elapsed()};}
  sample(ticket,items,ice){
    if(ticket.sequence<=this.accepted)return;
    this.accepted=ticket.sequence;
    const sample={...ticket,ice,available:Array.isArray(items),...(Array.isArray(items)?summarizeStats(items):{pairs:{},requestsSent:null,responsesReceived:null,selected:null})};
    this.data.latest=sample;
    if(Object.keys(sample.pairs).length)this.data.lastWithPairs=sample;
    this.data.samples.push(sample);if(this.data.samples.length>24)this.data.samples.shift();
  }
  event(type,state){this.data.events.push({atMs:this.elapsed(),type,state});if(this.data.events.length>80)this.data.events.shift();}
  operation(name,phase,error){
    const count=this.data.operations[name]??={attempted:0,applied:0,failed:0};count[phase]++;
    this.event(name,phase==='failed'?safeError(error):phase);
  }
  description(side,value){
    if(!value?.sdp)return;
    const routes={};for(const line of value.sdp.split(/\r?\n/))if(line.startsWith('a=candidate:')){const key=candidateRoute(line);routes[key]=(routes[key]||0)+1;}
    const summary={type:['offer','answer','pranswer','rollback'].includes(value.type)?value.type:'unknown',atMs:this.elapsed(),routes,hash:null};
    this.data.descriptions[side]=summary;
    const pending=digest(new TextEncoder().encode(value.sdp)).then(hash=>{summary.hash=hash;}).catch(()=>{}).finally(()=>this.pending.delete(pending));this.pending.add(pending);
  }
  localCandidate(value){if(!value?.candidate)return;const key=candidateRoute(value.candidate);this.data.localCandidates[key]=(this.data.localCandidates[key]||0)+1;}
  candidateError(code){if(Number.isInteger(code)&&this.data.candidateErrors.length<20)this.data.candidateErrors.push({atMs:this.elapsed(),code});}
  async flush(){await Promise.allSettled([...this.pending]);}
  snapshot(){return structuredClone(this.data);}
}

// Public simple-peer `wrtc` injection: observe native completion without changing
// SDP, candidates, configuration, error propagation or connection ordering.
export function observedRTC(native,evidence) {
  class ObservedConnection extends native.RTCPeerConnection {
    constructor(...args){
      super(...args);
      this.addEventListener('icecandidate',e=>evidence.localCandidate(e.candidate));
      this.addEventListener('icecandidateerror',e=>evidence.candidateError(e.errorCode));
      for(const [event,property] of [['iceconnectionstatechange','iceConnectionState'],['icegatheringstatechange','iceGatheringState'],['signalingstatechange','signalingState'],['connectionstatechange','connectionState']])this.addEventListener(event,()=>evidence.event(property,this[property]));
    }
    async setLocalDescription(...args){
      evidence.operation('localDescription','attempted');
      try{const result=await super.setLocalDescription(...args);evidence.operation('localDescription','applied');evidence.description('local',this.localDescription);return result;}
      catch(error){evidence.operation('localDescription','failed',error);throw error;}
    }
    async setRemoteDescription(...args){
      evidence.operation('remoteDescription','attempted');
      try{const result=await super.setRemoteDescription(...args);evidence.operation('remoteDescription','applied');evidence.description('remote',this.remoteDescription);return result;}
      catch(error){evidence.operation('remoteDescription','failed',error);throw error;}
    }
    async addIceCandidate(...args){
      evidence.operation('candidate','attempted');
      try{const result=await super.addIceCandidate(...args);evidence.operation('candidate','applied');return result;}
      catch(error){evidence.operation('candidate','failed',error);throw error;}
    }
  }
  return {RTCPeerConnection:ObservedConnection,RTCSessionDescription:native.RTCSessionDescription,RTCIceCandidate:native.RTCIceCandidate};
}

export async function localNetworkPermission(permissions=globalThis.navigator?.permissions){
  // Query only: never requests access or changes settings. Unsupported != denied.
  try {const result=await permissions.query({name:'local-network'});return ['granted','denied','prompt'].includes(result.state)?result.state:'unknown';}
  catch{return 'unsupported';}
}
export class DirectProbe {
  constructor({send,drain=async()=>{},onText=()=>{},onFile=()=>{},onSent=()=>{},onError=()=>{},ackTimeout=30000}) {
    Object.assign(this,{send,drain,onText,onFile,onSent,onError,ackTimeout});this.chain=Promise.resolve();this.incoming=null;this.pending=new Map();this.retained=0;this.retainedFiles=0;this.busy=false;this.disposed=false;
  }
  control(value){if(this.disposed)throw new Error('连接已结束。');this.send(JSON.stringify(value));}
  sendText(text){if(typeof text!=='string'||!text.trim()||new TextEncoder().encode(text).length>16000)throw new Error('文字请控制在 4000 字以内。');this.control({type:'text',text});}
  async sendFile(file){
    if(this.busy)throw new Error('请等待当前文件发送完成。');
    if(!file||file.size>MAX_PROBE_FILE||file.name.length>255)throw new Error('验证页单文件上限为 8 MiB。');
    this.busy=true;const id=crypto.randomUUID();
    try{
      const bytes=new Uint8Array(await file.arrayBuffer()),hash=await digest(bytes);
      this.control({type:'file',id,name:file.name,size:bytes.length});
      for(let at=0;at<bytes.length;at+=CHUNK){await this.drain();if(this.disposed)throw new Error('连接已结束。');this.send(bytes.slice(at,at+CHUNK));}
      const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('等待接收确认超时。'));},this.ackTimeout);this.pending.set(id,{hash,resolve,reject,timer});});
      done.catch(()=>{});this.control({type:'end',id,hash});await done;this.onSent({id,name:file.name,hash});
    }finally{this.busy=false;const pending=this.pending.get(id);if(pending){clearTimeout(pending.timer);pending.reject(new Error('发送已结束。'));this.pending.delete(id);}}
  }
  receive(data){this.chain=this.chain.then(()=>this.consume(data)).catch(error=>{this.incoming=null;this.onError(error.message);});return this.chain;}
  async consume(data){
    if(this.disposed)return;
    if(typeof data!=='string'){
      const bytes=data instanceof Uint8Array?data:new Uint8Array(data);const item=this.incoming;
      if(!item||bytes.length!==Math.min(CHUNK,item.size-item.offset)||!bytes.length)throw new Error('收到无效文件分块。');
      item.bytes.set(bytes,item.offset);item.offset+=bytes.length;return;
    }
    if(data.length>65536)throw new Error('消息过大。');const m=JSON.parse(data);
    if(!m||typeof m!=='object')throw new Error('无效消息。');
    if(m.type==='text'){
      if(typeof m.text!=='string'||new TextEncoder().encode(m.text).length>16000)throw new Error('文字过长。');this.onText(m.text);return;
    }
    if(m.type==='file'){
      if(this.incoming||this.retainedFiles>=20||typeof m.id!=='string'||m.id.length>64||typeof m.name!=='string'||m.name.length>255||!Number.isSafeInteger(m.size)||m.size<0||m.size>MAX_PROBE_FILE||this.retained+m.size>INBOX)throw new Error('接收文件超出验证页容量或当前仍有文件在接收。');
      this.incoming={id:m.id,name:m.name,size:m.size,offset:0,bytes:new Uint8Array(m.size)};return;
    }
    if(m.type==='end'){
      const item=this.incoming;if(!item||item.id!==m.id||item.offset!==item.size)throw new Error('文件尚未完整到达。');
      const hash=await digest(item.bytes);if(hash!==m.hash)throw new Error('文件校验不一致。');
      if(this.disposed)return;this.incoming=null;this.retained+=item.size;this.retainedFiles++;let released=false;
      this.control({type:'received',id:item.id,hash});
      this.onFile({...item,bytes:undefined,blob:new Blob([item.bytes]),hash,release:()=>{if(!released){released=true;this.retained-=item.size;this.retainedFiles--;}}});return;
    }
    if(m.type==='received'){
      const pending=this.pending.get(m.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(m.id);if(pending.hash===m.hash)pending.resolve();else pending.reject(new Error('接收确认的校验不一致。'));return;
    }
    throw new Error('无效消息类型。');
  }
  dispose(){this.disposed=true;this.incoming=null;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('连接已结束。'));}this.pending.clear();}
}
