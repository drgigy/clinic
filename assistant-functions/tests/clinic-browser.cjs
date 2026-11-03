const {chromium}=require('playwright');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');

(async()=>{
  const date=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const patient={id:'testA',patientId:'269901',name:'Synthetic Patient',date,age:'30',sex:'Female',mobile:'',visitType:'First consultation',mode:'In clinic',diagnosis:'Others',tests:[]};
  const {makeAssistantRecord,sections}=await import('../records.js');
  const summary=Object.fromEntries(sections.map(([key])=>[key,'Not reported']));
  summary.presentingComplaints='Historical assistant content must remain available.';
  const notes=[{id:'existing',patientId:patient.patientId,patientKey:patient.patientId,date,createdAt:new Date().toISOString(),source:'ambient',recordKind:'visit',note:'Original visit note.',docs:{visit:'<strong>History of Present Illness:</strong><br>Original visit note.'}},makeAssistantRecord('historic',{patient,appointmentId:patient.id},summary,new Date().toISOString())];
  const server=http.createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local').pathname;const file=path.join(root,name==='/'?'index.html':name);if(!file.startsWith(root+path.sep))throw Error();const bytes=await fs.readFile(file);res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(bytes);}catch{res.statusCode=404;res.end();}});
  await new Promise(resolve=>server.listen(8879,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(({patient,notes,date})=>{window.__data={patients:[patient],medicalRecords:notes};window.__writes=[];localStorage.setItem('clinicSelectedDate.v1',date);},{patient,notes,date});
    await context.route('**/firebase-app.js',r=>r.fulfill({contentType:'text/javascript',body:'export const initializeApp=()=>({});'}));
    await context.route('**/firebase-auth.js',r=>r.fulfill({contentType:'text/javascript',body:`const user={email:'test@invalid',getIdToken:async()=> 'fake'};const auth={currentUser:user,onAuthStateChanged(fn){setTimeout(()=>fn(user),0);return ()=>{};}};export const getAuth=()=>auth;export const onAuthStateChanged=(a,fn)=>a.onAuthStateChanged(fn);export const signInWithEmailAndPassword=async()=>({user});export const signOut=async()=>{};`}));
    await context.route('**/firebase-firestore.js',r=>r.fulfill({contentType:'text/javascript',body:`export const getFirestore=()=>({});export const collection=(db,name)=>({name});export const doc=(db,name,id)=>({name,id});export const query=ref=>ref;export const orderBy=()=>null;export const setDoc=async(ref,data)=>window.__writes.push({operation:'set',ref,data});export const deleteDoc=async ref=>window.__writes.push({operation:'delete',ref});export const onSnapshot=(ref,callback)=>{setTimeout(()=>ref.name==='settings'?callback({exists:()=>false}):callback({docs:(window.__data[ref.name]||[]).map(row=>({id:row.id,data:()=>row}))}),0);return ()=>{};};`}));
    let assistantCalls=0;
    await context.route('**/cloudfunctions.net/doctorAssistant',r=>{assistantCalls++;return r.abort();});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8879/');
    await page.locator('[data-main-tab="staff"]').first().click();
    await page.locator('[data-edit-patient="testA"]').waitFor();
    assert.equal(await page.locator('[data-doctor-assistant]').count(),0);
    assert.equal(await page.locator('#pairPatientDeviceBtn').count(),0);
    assert.equal((await page.request.get('http://127.0.0.1:8879/patient.html')).status(),404);
    await fs.mkdir('/private/tmp/clinic-retirement-review',{recursive:true});
    await page.screenshot({path:'/private/tmp/clinic-retirement-review/staff.png'});
    await page.locator('[data-medical-record="testA"]').click();
    await page.locator('[data-open-record="assistant_historic"]').click();
    assert.match(await page.locator('#medicalNoteText').textContent(),/Historical assistant content/);
    await page.locator('#recordSaveCloseBtn').click();
    await page.locator('[data-medical-record="testA"]').click();
    await page.locator('[data-open-record="existing"]').click();
    assert.match(await page.locator('#medicalNoteText').textContent(),/Original visit note/);
    assert.deepEqual(await page.evaluate(()=>window.__writes),[]);
    assert.equal(assistantCalls,0);
    assert.deepEqual(errors,[]);
    console.log('PASS: no assistant UI or API polling; patient.html removed; historical notes remain readable; no data writes. Synthetic data only.');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
