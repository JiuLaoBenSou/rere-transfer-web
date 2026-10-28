// Codex / 2026-10-29. Separate simple-peer transport; production page stays unchanged.
import {apiURL} from './app-config.js';
import {DirectProbe,peerOptions,signalEnvelope,summarizeStats,MAX_PROBE_FILE} from './direct-probe-core.js';
import {drawQR} from './vendor/reference/qr.js';
import './vendor/reference/simplepeer-9.11.1.min.js';
const $=s=>document.querySelector(s),modes=['standard','complete','lan'];
let mode=new URL(location.href).searchParams.get('mode')||'standard';if(!modes.includes(mode))mode='standard';$('#mode').value=mode;
let room=null,target=null,peer=null,transfer=null,ws=null,controller=null,busy=false,peerTimer,heartbeat,statsTimer;
let signaling=Promise.resolve(),messages=Promise.resolve(),lastStats={},ice='new',gathering='new',failure='',sent=0,received=0;
let signalCounts={sent:{},received:{}};
const downloads=[];
const error=message=>{$('#error').textContent=message||'';};
const status=message=>{$('#status').textContent=message;controls();};
function controls(){const connected=!!peer?.connected;$('#send-file').disabled=!connected||!!transfer?.busy||!$('#file').files.length;$('#send-text').disabled=!connected;$('#create').disabled=busy;$('#join-form button').disabled=busy;}
async function api(path,body,token,method='POST'){
 const response=await fetch(apiURL(path),{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body||{})});
 if(!response.ok){let detail;try{detail=(await response.json()).error;}catch{}throw new Error(detail||'配对请求失败（'+response.status+'）。');}
 return response.status===204?null:response.json();
}
function text(message,own=false){const p=document.createElement('p');p.textContent=(own?'我：':'对方：')+message;$('#messages').append(p);while($('#messages').children.length>40)$('#messages').firstElementChild.remove();$('#messages').scrollTop=$('#messages').scrollHeight;}
async function statistics(){
 const current=peer;if(!current||current.destroyed)return lastStats;
 const values=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),1500);current.getStats((err,items)=>{clearTimeout(timer);resolve(err?null:items);});});
 if(values&&peer===current)lastStats=summarizeStats(values);return lastStats;
}
async function diagnostic(){
 await statistics();const value={build:'reference1',engine:'simple-peer@9.11.1',mode,browser:navigator.userAgent,secureContext:isSecureContext,status:$('#status').textContent,ice,gathering,error:failure,signals:signalCounts,stats:lastStats,filesSent:sent,filesReceived:received};
 $('#diagnostic').value=JSON.stringify(value,null,2);return $('#diagnostic').value;
}
function closePeer(){clearTimeout(peerTimer);clearInterval(statsTimer);transfer?.dispose();transfer=null;const old=peer;peer=null;old?.destroy();controls();}
function stop(message){controller?.abort();controller=null;clearInterval(heartbeat);ws?.close();ws=null;closePeer();status(message);}
function connectPeer(member){
 target=member;const current=new globalThis.SimplePeer(peerOptions(room.peerId<member.peerId,mode));peer=current;failure='';lastStats={};ice='new';gathering='new';signalCounts={sent:{},received:{}};status('正在建立连接…');
 statsTimer=setInterval(()=>statistics(),3000);
 transfer=new DirectProbe({send:value=>current.send(value),drain:async()=>{const started=Date.now();while(current.bufferSize>256*1024){if(current.destroyed||peer!==current||Date.now()-started>15000)throw new Error('发送连接已中断。');await new Promise(r=>setTimeout(r,20));}},onText:value=>text(value),onFile:file=>{
   const url=URL.createObjectURL(file.blob),a=document.createElement('a');a.href=url;a.download=file.name;a.textContent='保存 '+file.name+' · 校验一致';$('#received').append(a);downloads.push({url,release:file.release});received++;
 },onSent:()=>{sent++;$('#file-status').textContent='对方已接收并校验。';},onError:error});
 const session=transfer;
 current.on('signal',signal=>{
   signaling=signaling.then(async()=>{if(peer!==current)return;const envelope=signalEnvelope(signal);await api('/api/groups/'+room.roomId+'/signal',{...envelope,generation:1,to:member.peerId,fromEpoch:room.epoch,toEpoch:member.epoch},room.token);signalCounts.sent[envelope.type]=(signalCounts.sent[envelope.type]||0)+1;}).catch(()=>{failure='SIGNAL_REQUEST_FAILED';error('协商消息未送达，请重新创建验证房间。');});
 });
 current.on('connect',()=>{if(peer!==current)return;clearTimeout(peerTimer);status('已连接，可以互传');statistics();});
 current.on('data',value=>session.receive(value));
 current.on('iceStateChange',(connection,gather)=>{ice=connection;gathering=gather;statistics();});
 current.on('error',event=>{if(peer!==current)return;failure=/^ERR_[A-Z_]+$/.test(event.code||'')?event.code:'PEER_ERROR';status('本次直连未成功');error('请展开「连接验证结果」查看本次结果。');});
 current.on('close',()=>{if(peer!==current)return;clearTimeout(peerTimer);clearInterval(statsTimer);session.dispose();if(!failure)status('连接已断开，请重新创建验证房间');controls();});
 peerTimer=setTimeout(async()=>{if(peer!==current||current.connected)return;await statistics();if(peer!==current||current.connected)return;failure='CONNECTION_TIMEOUT';status('本次直连未成功');current.destroy();},60000);
}
async function handle(message){
 if(!room||!controller||controller.signal.aborted)return;
 if(message.type==='auth-error'){stop('房间身份已失效，请重新创建');return;}
 if(message.type==='closed'){stop('房间已结束');return;}
 if(message.type==='members'){
   if(message.self){Object.assign(room,message.self);renderCode();}
   const others=message.peers;
   if(others.length>1){error('本验证页只比较两台设备，请退出后重新创建房间。');closePeer();status('设备超过验证上限');return;}
   if(target&&!others.some(p=>p.peerId===target.peerId)){closePeer();target=null;status('对方已退出，请重新创建验证房间');return;}
   const next=others.find(p=>p.online);
   if(next&&!next.label.startsWith('验证·'+mode)){error('双方需要打开相同连接方式的验证页面。');status('连接方式不一致');return;}
   if(next&&target&&(next.epoch!==target.epoch)){closePeer();status('对方页面已更新，请重新创建验证房间');return;}
   if(next&&!target)connectPeer(next);return;
 }
 if(!peer||!target||message.from!==target.peerId||message.fromEpoch!==target.epoch||message.toEpoch!==room.epoch||message.generation!==1)return;
 if(['ice','offer','answer'].includes(message.type))signalCounts.received[message.type]=(signalCounts.received[message.type]||0)+1;
 if(message.type==='ice')peer.signal({candidate:message.data});
 else if(['offer','answer'].includes(message.type))peer.signal(message.data);
}
function enqueue(message){messages=messages.then(()=>handle(message)).catch(()=>{failure='SIGNAL_APPLY_FAILED';error('本次连接协商失败，请重新创建验证房间。');});}
async function listen(){
 const signal=controller.signal;
 if(room.transport==='sse'){
   try{
     const response=await fetch(apiURL('/api/groups/'+room.roomId+'/events'),{headers:{Authorization:'Bearer '+room.token},signal});if(!response.ok)throw new Error('配对连接失败。');
     const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
     while(!signal.aborted){const{done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let boundary;while((boundary=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);for(const line of frame.split('\n'))if(line.startsWith('data: '))enqueue(JSON.parse(line.slice(6)));}}
   }catch{if(!signal.aborted)error('配对服务连接中断，请重新创建验证房间。');}return;
 }
 const url=new URL(apiURL('/api/groups/'+room.roomId+'/socket'));url.protocol=url.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(url);ws=socket;
 socket.onopen=()=>{if(signal.aborted){socket.close();return;}socket.send(JSON.stringify({type:'auth',token:room.token}));heartbeat=setInterval(()=>{if(socket.readyState===1)socket.send('ping');},15000);};
 socket.onmessage=event=>{if(event.data!=='pong')try{enqueue(JSON.parse(event.data));}catch{error('配对服务返回了无效消息。');}};
 socket.onclose=()=>{clearInterval(heartbeat);if(!signal.aborted)error('配对服务连接中断；请重新创建验证房间。');};
 socket.onerror=()=>{if(!signal.aborted)error('配对服务无法连接。');};
}
function renderCode(){if(!room)return;const remaining=Math.max(0,Math.ceil((room.pairingExpiresAt-Date.now())/1000));$('#code').textContent=remaining?room.pairingCode?.replace(/^(\d{3})(\d{3})$/,'$1 $2')||'':'已过期';$('#code-status').textContent=remaining?'配对码剩余 '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0'):'请使用二维码或链接加入。';}
async function enter(identity){
 if(!identity.group)throw new Error('请使用验证页的房间。');room=identity;controller=new AbortController();target=null;messages=Promise.resolve();signaling=Promise.resolve();
 $('#start').hidden=true;$('#room').hidden=false;$('#mode').disabled=true;$('#identity').textContent='本机：'+room.kind+' · '+$('#mode').selectedOptions[0].textContent;renderCode();
 const invite=new URL('direct-check.html',location.href);invite.searchParams.set('mode',mode);invite.searchParams.set('group',room.roomId);$('#invite').value=invite.href;await drawQR($('#qr'),invite.href);status('等待另一台设备');listen();
}
async function start(action){if(busy||room)return;busy=true;controls();error();try{if(!globalThis.SimplePeer?.WEBRTC_SUPPORT||!isSecureContext)throw new Error('请使用支持直连的浏览器打开 HTTPS 验证页。');await enter(await action());}catch(e){error(e.message);}finally{busy=false;controls();}}
function joinData(){return{label:'验证·'+mode,kind:/iPhone/.test(navigator.userAgent)?'iPhone':/Windows/.test(navigator.userAgent)?'Windows':/Macintosh/.test(navigator.userAgent)?'Mac':'浏览器'};}
$('#mode').onchange=()=>{mode=$('#mode').value;const url=new URL(location.href);url.searchParams.set('mode',mode);history.replaceState(null,'',url);};
$('#create').onclick=()=>start(()=>api('/api/groups',joinData()));
$('#join-form').onsubmit=event=>{event.preventDefault();start(()=>api('/api/pair',{code:$('#join-code').value,...joinData()}));};
$('#leave').onclick=async()=>{try{if(room)await api('/api/groups/'+room.roomId,{},room.token,'DELETE');}catch(e){error(e.message);}finally{stop('已退出验证');room=null;target=null;$('#start').hidden=false;$('#room').hidden=true;$('#mode').disabled=false;const url=new URL(location.href);url.searchParams.delete('group');history.replaceState(null,'',url);}};
$('#file').onchange=controls;
$('#send-file').onclick=async()=>{const session=transfer,file=$('#file').files[0];if(!session||!file)return;error();if(file.size>MAX_PROBE_FILE){error('验证页单文件上限为 8 MiB。');return;}try{const sending=session.sendFile(file);controls();$('#file-status').textContent='正在发送…';await sending;}catch(e){$('#file-status').textContent=e.message;}finally{controls();}};
$('#text-form').onsubmit=event=>{event.preventDefault();try{const value=$('#text').value;transfer.sendText(value);text(value,true);$('#text').value='';}catch(e){error(e.message);}};
function clearDownloads(){for(const file of downloads){URL.revokeObjectURL(file.url);file.release();}downloads.length=0;$('#received').replaceChildren();}
$('#clear').onclick=clearDownloads;$('#diagnose').onclick=diagnostic;
async function copy(value,input){try{await navigator.clipboard.writeText(value);}catch{input.focus();input.select();error('请复制已选中的内容。');}}
$('#copy-invite').onclick=()=>copy($('#invite').value,$('#invite'));$('#copy-diagnostic').onclick=async()=>copy(await diagnostic(),$('#diagnostic'));
const codeTimer=setInterval(()=>{renderCode();if(room&&Date.now()>=room.expiresAt)stop('房间已结束');},1000);
addEventListener('pagehide',()=>{clearInterval(codeTimer);stop('页面已关闭');clearDownloads();});
const group=new URL(location.href).searchParams.get('group');
if(group){if(/^[A-Za-z0-9_-]{32}$/.test(group))start(()=>api('/api/groups/'+group+'/join',joinData()));else error('验证链接无效。');}
