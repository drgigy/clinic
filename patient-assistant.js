import {assistantRequest} from './assistant-config.js';
import {createIcons, Mic, Send, Stethoscope, Languages, AudioLines, Square, ShieldCheck} from 'https://esm.sh/lucide@0.468.0';

createIcons({icons:{Mic,Send,Stethoscope,Languages,AudioLines,Square,ShieldCheck}});
const $ = id => document.getElementById(id);
let device = JSON.parse(sessionStorage.getItem('clinicAssistantDeviceAuth') || 'null');
let current = null;
let transcript = [];
let live = null;
let stream = null;
let input = null;
let output = null;
let processor = null;
let microphone = null;
let enabled = false;
let finishing = false;
let starting = false;
let voiceGeneration = 0;
let pollBusy = false;
let remoteStopHandled = false;
let nextPlay = 0;
let lastSpeech = 0;
let checkpointTimer;
let checkpointWork = Promise.resolve();
const sources = new Set();
const storageKey = id => `clinicAssistantTranscript.${id}`;
const api = (action,body={}) => assistantRequest(action,{deviceCode:device?.deviceCode,...body},{'X-Device-Token':device?.token || ''});
const error = message => {$('error').textContent=message;};
const status = message => {$('sessionStatus').textContent=message;document.body.dataset.voice=message.toLowerCase();};
const replyLanguage = () => document.querySelector('input[name="language"]:checked').value;
function persist(){
  try{sessionStorage.setItem(storageKey(current.id),JSON.stringify(transcript));}
  catch{error('This device could not keep a local recovery copy. Keep the page open until saving is confirmed.');}
}
function renderTranscript(){
  const container=$('messages');container.replaceChildren();
  let lastRole='';let bubble;
  for(const turn of transcript){
    if(turn.role==='assistant'&&turn.text==='\n\n'){lastRole='';continue;}
    if(turn.role==='patient'){lastRole='';continue;}
    if(turn.role!==lastRole){bubble=document.createElement('div');bubble.className=`message ${turn.role}`;const label=document.createElement('span');label.textContent=turn.role==='patient'?'You':'Doctor Assistant';bubble.append(label,document.createTextNode(''));container.append(bubble);lastRole=turn.role;}
    bubble.lastChild.textContent+=turn.text;
  }
  container.scrollTop=container.scrollHeight;
}
function add(role,text){
  if(!text || !current)return;
  transcript.push({role,text});lastSpeech=Date.now();persist();renderTranscript();
  clearTimeout(checkpointTimer);
  checkpointTimer=setTimeout(queueCheckpoint,800);
}
function queueCheckpoint(){
  if(!current || !transcript.some(t=>t.role==='patient'&&t.text.trim()))return checkpointWork;
  const id=current.id;const copy=transcript.map(turn=>({...turn}));
  checkpointWork=checkpointWork.catch(()=>{}).then(()=>api('checkpoint',{sessionId:id,transcript:copy}));
  checkpointWork.catch(()=>error('Connection interrupted. Your answers remain on this device. Keep this page open and retry.'));
  return checkpointWork;
}
function clearAudio(){for(const source of sources){try{source.stop();}catch{}}sources.clear();nextPlay=0;}
function stopVoice(){
  voiceGeneration++;
  const session=live;live=null;
  if(session)session.close();
  clearAudio();
  stream?.getAudioTracks().forEach(track=>{track.enabled=false;});
}
function play(data){
  if(finishing || !output)return;
  const binary=atob(data);const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  const pcm=new Int16Array(bytes.buffer);const buffer=output.createBuffer(1,pcm.length,24000);
  const channel=buffer.getChannelData(0);for(let i=0;i<pcm.length;i++)channel[i]=pcm[i]/32768;
  const source=output.createBufferSource();source.buffer=buffer;source.connect(output.destination);
  const time=Math.max(output.currentTime,nextPlay);nextPlay=time+buffer.duration;sources.add(source);
  source.onended=()=>{sources.delete(source);if(!sources.size&&!finishing)status('Listening');};source.start(time);status('Speaking');
}
async function startVoice(){
  if(starting || live || finishing)return;
  const generation=++voiceGeneration;
  starting=true;$('languagePicker').disabled=true;$('resume').hidden=true;$('confirmIdentity').disabled=true;error('');status('Connecting…');
  try{
    await output.resume();await input.resume();
    const [{GoogleGenAI},credentials]=await Promise.all([import('https://esm.sh/@google/genai@1.45.0'),api('token',{sessionId:current.id,language:replyLanguage()})]);
    if(generation!==voiceGeneration)return;
    const ai=new GoogleGenAI({apiKey:credentials.token,httpOptions:{apiVersion:'v1beta'}});
    const id=current.id;
    let sessionClosed=false;
    const session=await ai.live.connect({model:credentials.model,config:credentials.liveConfig,callbacks:{
      onmessage(message){
        if(current?.id!==id || generation!==voiceGeneration)return;
        const content=message.serverContent;
        if(content?.inputTranscription?.text)add('patient',content.inputTranscription.text);
        if(content?.outputTranscription?.text)add('assistant',content.outputTranscription.text);
        if(content?.interrupted)clearAudio();
        for(const part of content?.modelTurn?.parts||[])if(part.inlineData?.mimeType?.startsWith('audio/pcm'))play(part.inlineData.data);
        if(content?.turnComplete)add('assistant','\n\n');
        if(message.goAway){error('Voice session is ending. Resume the conversation or stop and save.');$('resume').hidden=false;}
      },
      onerror(){if(generation===voiceGeneration&&!finishing){stopVoice();status('Paused');error('Voice connection interrupted. Your answers are retained. Resume or stop and save.');$('resume').hidden=false;}},
      onclose(){sessionClosed=true;if(generation!==voiceGeneration)return;live=null;stream?.getAudioTracks().forEach(track=>{track.enabled=false;});if(!finishing){status('Paused');$('resume').hidden=false;}}
    }});
    if(generation!==voiceGeneration){session.close();return;}
    if(sessionClosed){session.close();throw new Error('Voice connection closed. Press Resume Conversation.');}
    live=session;stream.getAudioTracks().forEach(track=>{track.enabled=true;});
    $('identityCheck').hidden=true;$('messageForm').hidden=false;$('stop').hidden=false;
    const context=transcript.length ? `Continue this interview without repeating answered questions. Earlier transcript: ${JSON.stringify(transcript)}` : `The patient has confirmed this identity: ${JSON.stringify(current.patient)}. Greet them and begin collecting their presenting complaint.`;
    live.sendClientContent({turns:[{role:'user',parts:[{text:context}]}],turnComplete:true});
    status('Listening');
  }catch(e){stopVoice();error(e.message);$('resume').hidden=false;}
  finally{starting=false;$('confirmIdentity').disabled=false;$('languagePicker').disabled=finishing;}
}
async function enable(){
  $('enable').disabled=true;error('');
  try{
    output ||= new AudioContext({sampleRate:24000});await output.resume();
    stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    stream.getAudioTracks().forEach(track=>{track.enabled=false;});
    input=new AudioContext();await input.audioWorklet.addModule('assistant-mic-worklet.js');await input.resume();
    microphone=input.createMediaStreamSource(stream);processor=new AudioWorkletNode(input,'assistant-capture');
    processor.port.onmessage=event=>{
      if(!live||finishing)return;
      const pcm=new Int16Array(event.data.length);for(let i=0;i<pcm.length;i++)pcm[i]=Math.round(Math.max(-1,Math.min(1,event.data[i]))*32767);
      let binary='';for(const byte of new Uint8Array(pcm.buffer))binary+=String.fromCharCode(byte);
      live.sendRealtimeInput({audio:{data:btoa(binary),mimeType:`audio/pcm;rate=${input.sampleRate}`}});
    };
    microphone.connect(processor);processor.connect(input.destination);
    if(device){try{await api('poll');}catch{device=null;}}
    if(!device){device=await assistantRequest('register');sessionStorage.setItem('clinicAssistantDeviceAuth',JSON.stringify(device));}
    enabled=true;$('enable').hidden=true;$('pairing').hidden=false;$('deviceCode').textContent=device.deviceCode;
    $('waitingTitle').textContent='Ready for your consultation';$('waitingText').textContent='Please wait for the clinic staff.';$('connection').textContent='Connected';await poll();
  }catch(e){error(e.message);stream?.getTracks().forEach(t=>t.stop());await input?.close();input=null;}
  finally{$('enable').disabled=false;}
}
async function finish(){
  if(finishing||!current)return;
  finishing=true;$('languagePicker').disabled=true;$('stop').disabled=true;$('resume').hidden=true;$('messageForm').hidden=true;error('');status('Saving your answers…');
  try{
    stream?.getAudioTracks().forEach(track=>{track.enabled=false;});clearAudio();
    live?.sendRealtimeInput({audioStreamEnd:true});
    // Allow final speech transcription to arrive before taking the save snapshot.
    const deadline=Date.now()+3000;
    await new Promise(resolve=>setTimeout(resolve,1000));
    while(live && Date.now()<deadline && Date.now()-lastSpeech<700)await new Promise(resolve=>setTimeout(resolve,150));
    stopVoice();clearTimeout(checkpointTimer);await queueCheckpoint();
    if(!transcript.some(t=>t.role==='patient'&&t.text.trim())){
      await api('end-empty',{sessionId:current.id});completed('No patient answers were recorded. Please speak to the clinic staff.');return;
    }
    await api('finish',{sessionId:current.id,transcript});
    completed('Your answers have been saved for the doctor. Thank you.');
  }catch(e){error(e.message+' Keep this page open and press Stop Conversation to retry.');status('Save not confirmed');$('stop').disabled=false;$('resume').hidden=false;}
  finally{finishing=false;$('languagePicker').disabled=false;}
}
function completed(message){
  stopVoice();clearTimeout(checkpointTimer);
  if(current)sessionStorage.removeItem(storageKey(current.id));
  current=null;transcript=[];$('messages').replaceChildren();$('conversation').hidden=true;$('waiting').hidden=false;
  $('waitingTitle').textContent='Conversation ended';$('waitingText').textContent=message;$('stop').disabled=false;
}
async function poll(){
  if(!enabled||pollBusy||finishing)return;
  pollBusy=true;
  try{
    const {session}=await api('poll');$('connection').textContent='Connected';
    if(session && ['completed','abandoned'].includes(session.status)){
      if(current)completed(session.status==='completed'?'Your answers have been saved for the doctor. Thank you.':'The staff ended this session.');
      return;
    }
    if(!session)return;
    if(current?.id===session.id){
      if(session.stopRequested&&!finishing&&!remoteStopHandled){remoteStopHandled=true;await finish();return;}
      if(session.status==='ending'&&!finishing){stopVoice();status('Saving your answers…');}
      return;
    }
    stopVoice();current=session;remoteStopHandled=false;
    const local=JSON.parse(sessionStorage.getItem(storageKey(session.id))||'[]');const remote=session.transcript||[];
    transcript=local.length>=remote.length?local:remote;persist();
    $('waiting').hidden=true;$('conversation').hidden=false;$('patientName').textContent=session.patient.name;
    $('patientIdentity').textContent=`Patient ID: ${session.patient.patientId}`;
    $('identityCheck').hidden=false;$('confirmIdentity').disabled=false;$('stop').hidden=transcript.length===0;$('resume').hidden=true;$('messageForm').hidden=true;
    renderTranscript();status('Confirm your identity');error('');
    if(session.status==='ending'){$('identityCheck').hidden=true;$('stop').hidden=false;status('Save pending. Press Stop Conversation to retry.');}
  }catch(e){$('connection').textContent='Connection interrupted';error(e.message);}
  finally{pollBusy=false;}
}
$('enable').onclick=enable;
$('languagePicker').onchange=async()=>{
  $('messages').lang=replyLanguage()==='ml'?'ml':replyLanguage()==='en'?'en':'';
  if(live&&!finishing&&!starting){
    starting=true;$('languagePicker').disabled=true;$('stop').disabled=true;
    try{
      stream?.getAudioTracks().forEach(track=>{track.enabled=false;});
      clearAudio();live.sendRealtimeInput({audioStreamEnd:true});
      const deadline=Date.now()+3000;
      await new Promise(resolve=>setTimeout(resolve,1000));
      while(live&&Date.now()<deadline&&Date.now()-lastSpeech<700)await new Promise(resolve=>setTimeout(resolve,150));
      await queueCheckpoint();
      stopVoice();starting=false;
      if(!finishing&&current)await startVoice();
    }catch(e){stopVoice();error(e.message);$('resume').hidden=false;}
    finally{starting=false;$('languagePicker').disabled=finishing;$('stop').disabled=finishing;}
  }
};
$('confirmIdentity').onclick=startVoice;
$('resume').onclick=startVoice;
$('wrongIdentity').onclick=()=>{error('Please call the clinic staff. Do not continue under another person’s name.');$('confirmIdentity').disabled=true;};
$('stop').onclick=finish;
$('messageForm').onsubmit=event=>{event.preventDefault();const text=$('message').value.trim();if(!text||!live||finishing)return;add('patient',text+'\n');live.sendClientContent({turns:[{role:'user',parts:[{text}]}],turnComplete:true});$('message').value='';};
setInterval(poll,2500);
window.addEventListener('beforeunload',event=>{if(current){persist();event.preventDefault();event.returnValue='';}stopVoice();stream?.getTracks().forEach(track=>track.stop());});
