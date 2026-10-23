import {deviceAvailable} from './pairing.js';

export const sections = [
  ['presentingComplaints', 'Presenting Complaints'],
  ['historyOfPresentIllness', 'History of Present Illness'],
  ['pastMedicalHistory', 'Past Medical History'],
  ['pastSurgicalHistory', 'Past Surgical History'],
  ['reviewOfInvestigations', 'Review of Investigations'],
  ['currentMedication', 'Current Medication'],
  ['allergies', 'Allergies'],
  ['provisionalDiagnosis', 'Provisional Diagnosis (AI suggestion - doctor review required)']
];
export function validateNote(value) {
  if (!value || sections.some(([key]) => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 12000)) {
    throw new Error('The assistant summary was incomplete. Please retry saving.');
  }
  return Object.fromEntries(sections.map(([key]) => [key, value[key].trim()]));
}
export function validateTranscript(value) {
  if (!Array.isArray(value) || !value.length || value.length > 2000) throw new Error('Invalid conversation.');
  if (value.some(turn => !turn || !['patient', 'assistant'].includes(turn.role) || typeof turn.text !== 'string' || turn.text.length > 12000)) throw new Error('Invalid conversation.');
  if (!value.some(turn => turn.role === 'patient' && turn.text.trim())) throw new Error('No patient answers were captured. Please ask staff for help.');
  if (JSON.stringify(value).length > 300000) throw new Error('Conversation is too large. Please ask staff for help.');
  return value;
}
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function makeAssistantRecord(sessionId, session, summary, now) {
  const note = validateNote(summary);
  const patient = session.patient;
  const date = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const plain = 'Patient-reported history collected by Doctor Assistant; awaiting clinician review.\n\n' + sections.map(([key, title]) => `${title}:\n${note[key]}`).join('\n\n');
  const html = '<p>Patient-reported history collected by Doctor Assistant; awaiting clinician review.</p>' + sections.map(([key,title]) => `<section><h3>${escapeHtml(title)}</h3><p>${escapeHtml(note[key]).replace(/\n/g,'<br>')}</p></section>`).join('');
  return {id:`assistant_${sessionId}`,patientId:patient.patientId,patientKey:patient.patientId,appointmentId:session.appointmentId,name:patient.name,mobile:patient.mobile || '',date,createdAt:now,updatedAt:now,source:'assistant',recordKind:'assistant',assistantSessionId:sessionId,reviewStatus:'unreviewed',note:plain,noteHtml:html,docs:{visit:html}};
}

// This is the only medicalRecords write in the assistant backend. Never upsert.
export async function appendAssistantNote(db, sessionId, summary, now = new Date().toISOString()) {
  return db.runTransaction(async tx => {
    const ref = db.doc(`assistantSessions/${sessionId}`);
    const recordRef = db.doc(`medicalRecords/assistant_${sessionId}`);
    const lockRef = db.doc('assistantControl/active');
    const [snapshot, record, lock] = await Promise.all([tx.get(ref), tx.get(recordRef), tx.get(lockRef)]);
    if (!snapshot.exists) throw new Error('Session not found.');
    const session = snapshot.data();
    if (session.status === 'completed' && record.exists) return recordRef.id;
    if (record.exists) throw new Error('An entry already exists for this session. No record was changed.');
    if (session.status !== 'ending' || lock.data()?.sessionId !== sessionId) throw new Error('Session is not ready to save.');
    const newRecord = makeAssistantRecord(sessionId, session, summary, now);
    tx.create(recordRef, newRecord);
    tx.update(ref, {status:'completed',recordId:recordRef.id,completedAt:now});
    tx.set(lockRef, {sessionId:null});
    return recordRef.id;
  });
}

export async function startAssistantSession(db, sessionId, appointmentId, deviceCode, staffUid) {
  return db.runTransaction(async tx => {
    const lockRef = db.doc('assistantControl/active');
    const deviceRef = db.doc(`assistantDevices/${deviceCode}`);
    const patientRef = db.doc(`patients/${appointmentId}`);
    const [lock, device, patient] = await Promise.all([tx.get(lockRef),tx.get(deviceRef),tx.get(patientRef)]);
    if (lock.data()?.sessionId) throw new Error('Another patient conversation is still active. Finish it first.');
    if (!deviceAvailable(device.data()) || device.data().waiting || device.data().lastSeen < Date.now()-30000) throw new Error('Patient device is offline, awaiting approval, or disconnected. Open patient.html and connect the device from Home.');
    if (!patient.exists) throw new Error('Patient not found.');
    const p = patient.data();
    const patientId = String(p.patientId || p.uhid || p.idNumber || '').trim();
    if (!patientId || !p.name) throw new Error('This patient needs a valid UHID and name before starting.');
    tx.create(db.doc(`assistantSessions/${sessionId}`), {status:'waiting',appointmentId,deviceCode,staffUid,createdAt:new Date().toISOString(),patient:{name:p.name,patientId,age:p.age || '',sex:p.sex || p.gender || '',mobile:p.mobile || ''}});
    tx.set(lockRef, {sessionId,appointmentId,deviceCode,patientName:p.name,startedAt:new Date().toISOString()});
    tx.update(deviceRef, {sessionId});
  });
}

export async function saveTranscript(db, id, transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return;
  validateTranscript(transcript);
  await db.runTransaction(async tx => {
    const ref = db.doc(`assistantSessions/${id}`);
    const snapshot = await tx.get(ref);
    const session = snapshot.data();
    if (!session || !['waiting','active'].includes(session.status)) return;
    const previous = session.transcript || [];
    if (transcript.length < previous.length) return;
    if (previous.some((turn,i) => JSON.stringify(turn) !== JSON.stringify(transcript[i]))) throw new Error('Conversation recovery conflict. Ask staff for help.');
    tx.update(ref,{transcript,checkpointAt:new Date().toISOString()});
  });
}

export async function freezeTranscript(db,id) {
  return db.runTransaction(async tx => {
    const ref = db.doc(`assistantSessions/${id}`);
    const snapshot = await tx.get(ref);
    const saved = snapshot.data();
    if (!saved) throw new Error('Session not found.');
    if (saved.status === 'completed') return saved;
    if (!['waiting','active','ending'].includes(saved.status)) throw new Error('Session already ended.');
    validateTranscript(saved.transcript);
    tx.update(ref,{status:'ending'});
    return saved;
  });
}

export async function abandonEmptySession(db, id) {
  await db.runTransaction(async tx => {
    const ref = db.doc(`assistantSessions/${id}`);
    const lockRef = db.doc('assistantControl/active');
    const [snapshot,lock] = await Promise.all([tx.get(ref),tx.get(lockRef)]);
    if (lock.data()?.sessionId !== id) throw new Error('Session already ended.');
    const session = snapshot.data();
    if (session?.transcript?.some(turn => turn.role === 'patient' && turn.text.trim())) throw new Error('Patient answers exist. Finish and save this session instead.');
    tx.update(ref,{status:'abandoned',endedAt:new Date().toISOString()});
    tx.set(lockRef,{sessionId:null});
  });
}
