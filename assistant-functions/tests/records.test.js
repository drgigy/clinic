import test from 'node:test';
import assert from 'node:assert/strict';
import {createPairing,claimPairing,disconnectDevice,deviceAvailable,approveWaitingDevice} from '../pairing.js';
import {appendAssistantNote,startAssistantSession,saveTranscript,freezeTranscript,abandonEmptySession,makeAssistantRecord,validateTranscript,sections} from '../records.js';

// An atomic, serial transaction store: tests exercise the same read/create/update
// contract as Firestore without ever connecting to the clinic database.
class Store {
  constructor(seed){this.rows=new Map(Object.entries(structuredClone(seed)));this.tail=Promise.resolve();this.writes=[];}
  doc(path){return {path,id:path.split('/').at(-1)};}
  runTransaction(work){
    const run=this.tail.then(async()=>{
      const next=new Map(structuredClone([...this.rows]));const writes=[];
      const tx={
        get:async ref=>({exists:next.has(ref.path),data:()=>structuredClone(next.get(ref.path))}),
        create:(ref,value)=>{assert.equal(next.has(ref.path),false,'create must not overwrite');next.set(ref.path,structuredClone(value));writes.push(['create',ref.path]);},
        update:(ref,value)=>{assert.equal(next.has(ref.path),true);next.set(ref.path,{...next.get(ref.path),...structuredClone(value)});writes.push(['update',ref.path]);},
        set:(ref,value)=>{next.set(ref.path,structuredClone(value));writes.push(['set',ref.path]);}
      };
      const result=await work(tx);this.rows=next;this.writes.push(...writes);return result;
    });
    this.tail=run.catch(()=>{});return run;
  }
}
const patient={name:'Test Patient',patientId:'TEST-1',mobile:'',age:'30',sex:'Female'};
test('waiting device cannot start before staff approval; approval is persistent and changes no clinical data',async()=>{
  const db=new Store({'patients/appointment':patient,'medicalRecords/old':{note:'untouched'},'assistantDevices/waiting':{waiting:true,lastSeen:Date.now(),expiresAt:Date.now()+60000}});
  await assert.rejects(startAssistantSession(db,'session','appointment','waiting','staff'),/awaiting approval/);
  await approveWaitingDevice(db,'waiting',null,'staff');
  await approveWaitingDevice(db,'waiting',null,'staff');
  assert.equal(db.rows.get('assistantDevices/waiting').waiting,false);
  assert.equal(deviceAvailable(db.rows.get('assistantDevices/waiting'),Date.now()+365*86400000),true);
  assert.equal(db.writes.some(([,path])=>/^(patients|medicalRecords)\//.test(path)),false);
});
test('staff approval rejects offline, expired, conflicting and active-session replacements',async()=>{
  const now=Date.now();
  const db=new Store({'assistantDevices/one':{waiting:true,lastSeen:now,expiresAt:now+60000},'assistantDevices/two':{waiting:true,lastSeen:now,expiresAt:now+60000},'assistantDevices/offline':{waiting:true,lastSeen:now-60000,expiresAt:now+60000}});
  await assert.rejects(approveWaitingDevice(db,'offline',null,'staff'),/no longer waiting/);
  await assert.rejects(approveWaitingDevice(db,'one',null,'staff',now+70000),/no longer waiting/);
  const results=await Promise.allSettled([approveWaitingDevice(db,'one',null,'staff'),approveWaitingDevice(db,'two',null,'staff')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  db.rows.set('assistantControl/active',{sessionId:'active'});
  await assert.rejects(approveWaitingDevice(db,'two','one','staff'),/active/);
});
test('QR claim is single-device, retryable, persistent, revocable and preserves clinical data',async()=>{
  const db=new Store({'patients/p':{name:'Untouched'},'medicalRecords/n':{note:'Untouched'}});
  await createPairing(db,'invite','device','staff',1000);
  assert.deepEqual(await claimPairing(db,'invite','token',2000),{deviceCode:'device'});
  assert.deepEqual(await claimPairing(db,'invite','token',3000),{deviceCode:'device'});
  await assert.rejects(claimPairing(db,'invite','other',3000),/already been used/);
  assert.equal(deviceAvailable(db.rows.get('assistantDevices/device'),Date.now()+365*86400000),true);
  await disconnectDevice(db);
  assert.equal(deviceAvailable(db.rows.get('assistantDevices/device')),false);
  await assert.rejects(claimPairing(db,'invite','token',4000),/already been used/);
  assert.equal(db.writes.some(([,path])=>/^(patients|medicalRecords)\//.test(path)),false);
});
test('QR expiration, supersession and active conversations prevent pairing mutations',async()=>{
  const db=new Store({});
  await createPairing(db,'old','oldDevice','staff',1000);
  await createPairing(db,'new','newDevice','staff',2000);
  await assert.rejects(claimPairing(db,'old','token',3000),/replaced/);
  await assert.rejects(claimPairing(db,'new','token',302000),/expired/);
  db.rows.set('assistantControl/active',{sessionId:'active'});
  const before=JSON.stringify([...db.rows]);
  await assert.rejects(claimPairing(db,'new','token',3000),/active/);
  await assert.rejects(createPairing(db,'third','thirdDevice','staff',3000),/active/);
  await assert.rejects(disconnectDevice(db),/active/);
  assert.equal(JSON.stringify([...db.rows]),before);
});
test('concurrent scanners cannot share a QR and replacement revokes previous device',async()=>{
  const db=new Store({});
  await createPairing(db,'one','oneDevice','staff');
  const results=await Promise.allSettled([claimPairing(db,'one','token1'),claimPairing(db,'one','token2')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await createPairing(db,'two','twoDevice','staff');
  await claimPairing(db,'two','token3');
  assert.equal(deviceAvailable(db.rows.get('assistantDevices/oneDevice')),false);
  assert.equal(deviceAvailable(db.rows.get('assistantDevices/twoDevice')),true);
});
const answers=[{role:'assistant',text:'What brings you here?'},{role:'patient',text:'A headache since yesterday. Levipil 1 gram is a current medicine.'}];
const summary=Object.fromEntries(sections.map(([key])=>[key,'Not reported']));
summary.currentMedication='Levipil 1 gram, patient reported. Schedule not reported.';
summary.presentingComplaints='Headache since yesterday.';
summary.provisionalDiagnosis='Insufficient information';
function seed(status='ending'){
  return new Store({
    'patients/appointment':patient,
    'medicalRecords/old_visit':{id:'old_visit',note:'Existing full clinical note',docs:{visit:'<p>Do not change</p>'}},
    'medicalRecords/old_rx':{id:'old_rx',note:'Existing prescription 1 gram'},
    'assistantSessions/session1':{status,appointmentId:'appointment',patient,deviceCode:'device',transcript:answers},
    'assistantControl/active':{sessionId:'session1'},
    'assistantDevices/device':{expiresAt:Date.now()+60000,lastSeen:Date.now()}
  });
}
test('adds exactly one sidebar record and preserves every patient and existing note byte-for-byte',async()=>{
  const db=seed();const before=JSON.stringify([...db.rows].filter(([key])=>key.startsWith('patients/')||key.startsWith('medicalRecords/')));
  const id=await appendAssistantNote(db,'session1',summary,'2026-10-23T08:30:00.000Z');
  assert.equal(id,'assistant_session1');
  const after=JSON.stringify([...db.rows].filter(([key])=>(key.startsWith('patients/')||key.startsWith('medicalRecords/'))&&key!=='medicalRecords/'+id));
  assert.equal(after,before);
  assert.deepEqual(db.writes.filter(([,key])=>key.startsWith('medicalRecords/')),[['create','medicalRecords/assistant_session1']]);
  const record=db.rows.get('medicalRecords/'+id);
  assert.equal(record.recordKind,'assistant');assert.equal(record.patientId,'TEST-1');assert.equal(record.date,'2026-10-23');assert.match(record.note,/Levipil 1 gram/);
  assert.equal(db.rows.get('assistantControl/active').sessionId,null);
});
test('simultaneous finish and retries produce a single immutable note',async()=>{
  const db=seed();const ids=await Promise.all([appendAssistantNote(db,'session1',summary),appendAssistantNote(db,'session1',{...summary,currentMedication:'Changed'})]);
  assert.deepEqual(ids,['assistant_session1','assistant_session1']);
  assert.match(db.rows.get('medicalRecords/assistant_session1').note,/Levipil 1 gram/);
  assert.equal(db.writes.filter(([action,path])=>action==='create'&&path.startsWith('medicalRecords/')).length,1);
});
test('an existing record collision is refused without touching any document',async()=>{
  const db=seed();db.rows.set('medicalRecords/assistant_session1',{note:'Original content'});
  const before=structuredClone([...db.rows]);
  await assert.rejects(appendAssistantNote(db,'session1',summary),/already exists/);
  assert.deepEqual([...db.rows],before);assert.deepEqual(db.writes,[]);
});
test('a session cannot write while another patient owns the lock',async()=>{
  const db=seed();db.rows.set('assistantControl/active',{sessionId:'other'});
  await assert.rejects(appendAssistantNote(db,'session1',summary),/not ready/);
  assert.equal(db.rows.has('medicalRecords/assistant_session1'),false);
});
test('two simultaneous starts select exactly one patient without modifying their records',async()=>{
  const db=seed();db.rows.set('assistantControl/active',{sessionId:null});
  const before=structuredClone(db.rows.get('patients/appointment'));
  const outcomes=await Promise.allSettled([startAssistantSession(db,'a','appointment','device','staff'),startAssistantSession(db,'b','appointment','device','staff')]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
  assert.deepEqual(db.rows.get('patients/appointment'),before);
  assert.equal(db.writes.some(([,p])=>p.startsWith('patients/')||p.startsWith('medicalRecords/')),false);
});
test('offline device and missing UHID cannot start a session',async()=>{
  const db=seed();db.rows.set('assistantControl/active',{sessionId:null});
  db.rows.get('assistantDevices/device').lastSeen=0;
  await assert.rejects(startAssistantSession(db,'a','appointment','device','staff'),/offline/);
  db.rows.get('assistantDevices/device').lastSeen=Date.now();delete db.rows.get('patients/appointment').patientId;
  await assert.rejects(startAssistantSession(db,'a','appointment','device','staff'),/UHID/);
  assert.deepEqual(db.writes,[]);
});
test('late or conflicting checkpoints cannot replace captured answers',async()=>{
  const db=seed('active');const extended=[...answers,{role:'patient',text:'No known allergies.'}];
  await saveTranscript(db,'session1',extended);
  await saveTranscript(db,'session1',answers);
  assert.deepEqual(db.rows.get('assistantSessions/session1').transcript,extended);
  await assert.rejects(saveTranscript(db,'session1',[{role:'patient',text:'Different'},...answers]),/conflict/);
  const frozen=await freezeTranscript(db,'session1');assert.deepEqual(frozen.transcript,extended);
  await saveTranscript(db,'session1',[...extended,{role:'patient',text:'Late text'}]);
  assert.deepEqual(db.rows.get('assistantSessions/session1').transcript,extended);
});
test('empty sessions create no notes; sessions containing answers cannot be abandoned',async()=>{
  const db=seed('active');await assert.rejects(abandonEmptySession(db,'session1'),/answers exist/);
  db.rows.get('assistantSessions/session1').transcript=[];
  await assert.rejects(freezeTranscript(db,'session1'),/Invalid conversation/);
  await abandonEmptySession(db,'session1');
  assert.equal(db.rows.has('medicalRecords/assistant_session1'),false);
  assert.equal(db.rows.get('assistantControl/active').sessionId,null);
});
test('malformed summaries are not saved and model markup is escaped',async()=>{
  const db=seed();await assert.rejects(appendAssistantNote(db,'session1',{}),/incomplete/);
  assert.deepEqual(db.writes,[]);
  const record=makeAssistantRecord('s',db.rows.get('assistantSessions/session1'),{...summary,allergies:'<script>alert(1)</script>'},'2026-10-23T22:00:00Z');
  assert.equal(record.date,'2026-10-24');assert.ok(!record.noteHtml.includes('<script>'));assert.ok(record.noteHtml.includes('&lt;script&gt;'));
  assert.throws(()=>validateTranscript([{role:'assistant',text:'Patient denies allergies'}]),/No patient answers/);
  assert.throws(()=>validateTranscript([null]),/Invalid conversation/);
});
