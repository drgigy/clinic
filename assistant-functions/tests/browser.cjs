const {chromium}=require('playwright');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');

(async()=>{
  const {makeAssistantRecord,sections}=await import('../records.js');
  const date=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const firstId=date.slice(2,4)+'9901',secondId=date.slice(2,4)+'9902';
  const patients=[{id:'testA',patientId:firstId,name:'Test Patient Alpha',date,age:'30',sex:'Female',mobile:'',visitType:'First consultation',mode:'In clinic',diagnosis:'Others',tests:[]},{id:'testB',patientId:secondId,name:'Test Patient Beta',date,age:'45',sex:'Male',mobile:'',visitType:'Review',mode:'In clinic',diagnosis:'Others',tests:[]}];
  const original=[{id:'existing',patientId:firstId,patientKey:firstId,date,createdAt:new Date().toISOString(),source:'ambient',recordKind:'visit',note:'History of Present Illness:\nExisting note must be preserved.',docs:{visit:'<strong>History of Present Illness:</strong><br>Existing note must be preserved.'}}];
  const originalCopy=JSON.stringify(original);
  const summary=Object.fromEntries(sections.map(([key])=>[key,'Not reported']));summary.presentingComplaints='Headache';summary.provisionalDiagnosis='DOCTOR ONLY ASSESSMENT';
  let session=null,active=null,transcript=[],notes=[...original],finishAttempts=0,failNextFinish=true;
  const writes=[];const errors=[];
  const server=http.createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local').pathname;const file=path.join(root,name==='/'?'index.html':name);if(!file.startsWith(root+path.sep))throw Error();const bytes=await fs.readFile(file);res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(bytes);}catch{res.statusCode=404;res.end();}});
  await new Promise(resolve=>server.listen(8879,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
    const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['microphone']});
    await context.addInitScript(({patients,notes,date})=>{
      window.__data={patients,medicalRecords:notes};window.__writes=[];window.__listeners={};
      localStorage.setItem('clinicSelectedDate.v1',date);
      localStorage.setItem('clinicAssistantDevice','0123456789abcdef');
    },{patients,notes,date});
    await context.route('**/firebase-app.js',route=>route.fulfill({contentType:'text/javascript',body:'export const initializeApp=()=>({});'}));
    await context.route('**/firebase-auth.js',route=>route.fulfill({contentType:'text/javascript',body:`const user={email:'test@invalid',getIdToken:async()=> 'fake-staff-token'};const auth={currentUser:user,onAuthStateChanged(fn){setTimeout(()=>fn(user),0);return ()=>{};}};export const getAuth=()=>auth;export const onAuthStateChanged=(auth,fn)=>auth.onAuthStateChanged(fn);export const signInWithEmailAndPassword=async()=>({user});export const signOut=async()=>{};`}));
    await context.route('**/firebase-firestore.js',route=>route.fulfill({contentType:'text/javascript',body:`export const getFirestore=()=>({});export const collection=(db,name)=>({name});export const doc=(db,name,id)=>({name,id});export const query=ref=>ref;export const orderBy=()=>null;export const setDoc=async(ref,data)=>window.__writes.push({operation:'set',ref,data});export const deleteDoc=async ref=>window.__writes.push({operation:'delete',ref});export const onSnapshot=(ref,callback)=>{const emit=()=>ref.name==='settings'?callback({exists:()=>false}):callback({docs:(window.__data[ref.name]||[]).map(row=>({id:row.id,data:()=>row}))});window.__listeners[ref.name]=emit;setTimeout(emit,0);return ()=>{};};`}));
    await context.route('https://esm.sh/@google/genai@1.45.0',route=>route.fulfill({contentType:'text/javascript',body:`export class GoogleGenAI{constructor(){this.live={connect:async({callbacks})=>({sendRealtimeInput:()=>{},sendClientContent:({turns})=>{const text=turns[0].parts[0].text;queueMicrotask(()=>callbacks.onmessage({serverContent:{outputTranscription:{text:text.includes('confirmed this identity')?'Hello. What brings you here?':'Thank you. Are you taking any medicines?'},turnComplete:true}}));},close:()=>callbacks.onclose()})};}}`}));
    await context.route('https://asia-south1-clinic-app-cccc0.cloudfunctions.net/doctorAssistant',async route=>{
      if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type,authorization,x-device-token','Access-Control-Allow-Methods':'POST,OPTIONS'}});return;}
      const b=route.request().postDataJSON();let result={},code=200;
      if(b.action==='register')result={deviceCode:'0123456789abcdef',token:'fake-device-token'};
      else if(b.action==='status')result={active};
      else if(b.action==='start'){
        if(active){code=400;result={error:'Another patient conversation is active.'};}
        else{const patient=patients.find(p=>p.id===b.appointmentId);session={id:'session-test',status:'waiting',patient,transcript:[]};active={sessionId:session.id,appointmentId:patient.id,patientName:patient.name};result={sessionId:session.id};}
      }else if(b.action==='poll')result={session:session?{...session,transcript}:null};
      else if(b.action==='token'){session.status='active';result={token:'fake',model:'test',liveConfig:{}};}
      else if(b.action==='checkpoint'){transcript=b.transcript;result={saved:true};}
      else if(b.action==='finish'){
        finishAttempts++;
        if(failNextFinish){failNextFinish=false;code=400;result={error:'Simulated temporary save failure.'};}
        else{if(!notes.some(n=>n.id==='assistant_session-test'))notes.push(makeAssistantRecord(session.id,{patient:session.patient,appointmentId:session.patient.id},summary,new Date().toISOString()));session.status='completed';active=null;result={saved:true,recordId:'assistant_session-test'};}
      }else throw Error('Unexpected action '+b.action);
      await route.fulfill({status:code,contentType:'application/json',body:JSON.stringify(result),headers:{'Access-Control-Allow-Origin':'*'}});
    });
    let confirmDelete=false;
    const staff=await context.newPage();staff.on('pageerror',e=>errors.push('staff: '+e.message));staff.on('dialog',dialog=>dialog.message().startsWith('Delete ')&&!confirmDelete?dialog.dismiss():dialog.accept());
    await staff.goto('http://127.0.0.1:8879/');
    await staff.locator('[data-main-tab="staff"]').first().click();
    await staff.locator('[data-doctor-assistant="testA"]').waitFor();
    await staff.waitForFunction(()=>!document.querySelector('[data-doctor-assistant="testA"]').disabled);
    const tablet=await context.newPage();tablet.on('pageerror',e=>errors.push('tablet: '+e.message));
    await tablet.goto('http://127.0.0.1:8879/patient.html');
    await tablet.locator('#enable').click();await tablet.locator('#pairing').waitFor({state:'visible'});
    await staff.locator('[data-doctor-assistant="testA"]').click();
    await staff.waitForFunction(()=>document.querySelector('[data-doctor-assistant="testB"]').disabled);
    await tablet.locator('#confirmIdentity').waitFor({state:'visible'});
    assert.equal(await tablet.locator('#patientName').textContent(),'Test Patient Alpha');
    await tablet.locator('#confirmIdentity').click();await tablet.locator('#messageForm').waitFor({state:'visible'});
    await tablet.locator('#message').fill('Headache since yesterday. Current medicine Levipil 1 gram.');
    await tablet.locator('#messageForm button').click();
    await tablet.waitForFunction(()=>document.getElementById('messages').textContent.includes('Levipil 1 gram'));
    await fs.mkdir('/private/tmp/clinic-assistant-review',{recursive:true});
    await tablet.screenshot({path:'/private/tmp/clinic-assistant-review/patient-desktop.png',fullPage:true});
    await tablet.setViewportSize({width:390,height:844});
    assert.equal(await tablet.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await tablet.screenshot({path:'/private/tmp/clinic-assistant-review/patient-mobile.png',fullPage:true});
    await tablet.locator('#stop').click();
    await tablet.waitForFunction(()=>document.getElementById('sessionStatus').textContent==='Save not confirmed');
    assert.ok(active,'failed save must retain lock');assert.equal(notes.length,1);
    await tablet.locator('#stop').click();await tablet.locator('#waiting').waitFor({state:'visible'});
    assert.equal(finishAttempts,2);assert.equal(notes.length,2);assert.equal(JSON.stringify(notes.slice(0,1)),originalCopy);
    assert.equal(await tablet.locator('body').textContent().then(t=>t.includes('DOCTOR ONLY')),false);
    assert.equal(await tablet.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('clinicAssistantTranscript.'))),false);
    await staff.evaluate(notes=>{window.__data.medicalRecords=notes;window.__listeners.medicalRecords();},notes);
    await staff.locator('[data-medical-record="testA"]').click();
    await staff.locator('[data-open-record="existing"]').click();
    const visitHeadingStyle=await staff.locator('#medicalNoteText strong').first().evaluate(el=>{const s=getComputedStyle(el);return {fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight};});
    await staff.locator('[data-open-record="assistant_session-test"]').click();
    const assistantHeadingStyle=await staff.locator('#medicalNoteText .assistant-note-body h3').first().evaluate(el=>{const s=getComputedStyle(el);return {fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight};});
    assert.deepEqual(assistantHeadingStyle,visitHeadingStyle,'Assistant headings must match Visit Note typography');
    assert.match(await staff.locator('#medicalNoteText').textContent(),/DOCTOR ONLY ASSESSMENT/);
    assert.equal(await staff.locator('#medicalNoteText').getAttribute('contenteditable'),'false');
    assert.equal(await staff.locator('#recordDeleteBtn').isVisible(),true);
    await staff.locator('#recordDeleteBtn').click();
    assert.equal(await staff.locator('[data-open-record="assistant_session-test"]').count(),1,'cancel must retain the entry');
    await staff.screenshot({path:'/private/tmp/clinic-assistant-review/assistant-sidebar.png',fullPage:true});
    await staff.locator('#recordSaveCloseBtn').click();
    writes.push(...await staff.evaluate(()=>window.__writes));
    assert.equal(writes.filter(w=>w.ref.name==='patients'||w.ref.name==='medicalRecords').length,0,'EMR must not save existing data during assistant workflow');
    await staff.locator('[data-medical-record="testA"]').click();
    await staff.locator('[data-open-record="assistant_session-test"]').click();
    confirmDelete=true;
    await staff.locator('#recordDeleteBtn').click();
    assert.equal(await staff.locator('[data-open-record="assistant_session-test"]').count(),0);
    assert.equal(await staff.locator('[data-open-record="existing"]').count(),1,'other notes must remain');
    const clinicalWrites=await staff.evaluate(()=>window.__writes.filter(w=>w.ref.name==='patients'||w.ref.name==='medicalRecords'));
    assert.deepEqual(clinicalWrites,[{operation:'delete',ref:{name:'medicalRecords',id:'assistant_session-test'}}]);
    await staff.locator('#recordCloseBtn').click();
    await staff.locator('[data-main-tab="doctor"]').first().click();
    assert.equal(await staff.locator('[data-doctor-assistant]:visible').count(),0,'Doctor tab must not show assistant buttons');
    await staff.locator('[data-main-tab="staff"]').first().click();
    await staff.waitForFunction(()=>!document.querySelector('[data-doctor-assistant="testB"]').disabled);
    assert.deepEqual(errors,[]);
    console.log('PASS: two-device flow, preservation, confirmed single-entry deletion, cancel safety, staff-only buttons, read-only note, private assessment, mobile layout. No live database used.');
  }catch(error){console.error('Browser errors:',errors);throw error;}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
