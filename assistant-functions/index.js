import {randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {onRequest} from 'firebase-functions/v2/https';
import {defineSecret} from 'firebase-functions/params';
import {initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {GoogleGenAI} from '@google/genai';
import {interviewPromptForLanguage, notePrompt} from './prompts.js';
import {deviceAvailable, createPairing, claimPairing, disconnectDevice} from './pairing.js';
import {appendAssistantNote, startAssistantSession, saveTranscript, freezeTranscript, abandonEmptySession, validateNote} from './records.js';

initializeApp();
const db = getFirestore();
const key = defineSecret('DOCTOR_ASSISTANT_GEMINI_KEY');
const hash = text => createHash('sha256').update(text).digest('hex');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value);
const staffActions = new Set(['start','status','staff-finish','abandon','pair-create','pair-disconnect']);

async function staff(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /,'');
  if (!token) throw new Error('Staff sign-in required.');
  return getAuth().verifyIdToken(token, true);
}
async function device(req, code) {
  if (!validId(code)) throw new Error('Invalid patient device.');
  const ref = db.doc(`assistantDevices/${code}`);
  const snapshot = await ref.get();
  const token = String(req.headers['x-device-token'] || '');
  const saved = snapshot.data();
  if (!deviceAvailable(saved) || !token || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(saved.tokenHash))) throw new Error('Patient device disconnected or expired. Ask staff to connect this device again.');
  return {ref, ...saved};
}
async function getSession(id, code) {
  if (!validId(id)) throw new Error('Invalid session.');
  const ref = db.doc(`assistantSessions/${id}`);
  const snapshot = await ref.get();
  if (!snapshot.exists || (code && snapshot.data().deviceCode !== code)) throw new Error('Session does not belong to this device.');
  return {ref,...snapshot.data()};
}
async function checkpoint(id, transcript) {
  return saveTranscript(db,id,transcript);
}
async function finish(id) {
  if (!validId(id)) throw new Error('Invalid session.');
  const session = await freezeTranscript(db,id);
  if (session.status === 'completed') return {saved:true,recordId:session.recordId};
  const ai = new GoogleGenAI({apiKey:key.value()});
  // The clinical assessment is generated on the server and never returned to the kiosk.
  const response = await ai.models.generateContent({model:'gemini-2.5-flash',contents:JSON.stringify(session.transcript),config:{systemInstruction:notePrompt,responseMimeType:'application/json',temperature:0.1}});
  const summary = validateNote(JSON.parse(response.text));
  const recordId = await appendAssistantNote(db,id,summary);
  return {saved:true,recordId};
}

export const doctorAssistant = onRequest({region:'asia-south1',secrets:[key],timeoutSeconds:120,maxInstances:5,concurrency:20,cors:['https://neuroclinic.woyz.in','http://localhost:8879','http://127.0.0.1:8879']},async (req,res) => {
  res.set('Cache-Control','no-store');
  if (req.method !== 'POST') {res.status(405).json({error:'POST required.'});return;}
  const body = req.body || {};
  const {action,sessionId,deviceCode} = body;
  try {
    const user = staffActions.has(action) ? await staff(req) : null;
    if (action === 'pair-create') {
      const invitation = randomBytes(32).toString('hex');
      const result = await createPairing(db,hash(invitation),randomBytes(8).toString('hex'),user.uid);
      res.json({...result,invitation});return;
    }
    if (action === 'pair-claim') {
      if (!/^[a-f0-9]{64}$/.test(body.invitation || '') || !/^[a-f0-9]{64}$/.test(body.token || '')) throw new Error('Invalid device pairing.');
      res.json(await claimPairing(db,hash(body.invitation),hash(body.token)));return;
    }
    if (action === 'pair-disconnect') {
      await disconnectDevice(db);res.json({disconnected:true});return;
    }
    if (action === 'register') {
      const code = randomBytes(8).toString('hex');
      const token = randomBytes(32).toString('hex');
      await db.doc(`assistantDevices/${code}`).create({tokenHash:hash(token),expiresAt:Date.now()+12*60*60*1000,lastSeen:Date.now(),sessionId:null});
      res.json({deviceCode:code,token});return;
    }
    if (action === 'status') {
      const lock = (await db.doc('assistantControl/active').get()).data();
      let status = null;
      if (lock?.sessionId) status = (await getSession(lock.sessionId)).status;
      const code = (await db.doc('assistantControl/device').get()).data()?.deviceCode;
      const paired = code ? (await db.doc(`assistantDevices/${code}`).get()).data() : null;
      res.json({active:lock?.sessionId ? {...lock,status} : null,pairedDevice:deviceAvailable(paired) ? {deviceCode:code,online:paired.lastSeen>Date.now()-30000} : null});return;
    }
    if (action === 'start') {
      const pairedCode = (await db.doc('assistantControl/device').get()).data()?.deviceCode || deviceCode;
      if (!validId(body.appointmentId) || !validId(pairedCode)) throw new Error('Choose a patient and connect the patient device from Home.');
      const id = randomBytes(16).toString('hex');
      await startAssistantSession(db,id,body.appointmentId,pairedCode,user.uid);
      res.json({sessionId:id});return;
    }
    if (action === 'abandon') {
      const session = await getSession(sessionId);
      const tablet = (await db.doc(`assistantDevices/${session.deviceCode}`).get()).data();
      if (session.status === 'active' && tablet?.lastSeen > Date.now()-30000) throw new Error('Patient device is still recording. Stop the conversation on that device first.');
      await abandonEmptySession(db,sessionId);
      res.json({ended:true});return;
    }
    if (action === 'staff-finish') {
      const session = await getSession(sessionId);
      if (session.status === 'waiting') throw new Error('No patient answers have been captured.');
      const tablet = (await db.doc(`assistantDevices/${session.deviceCode}`).get()).data();
      if (['waiting','active'].includes(session.status) && tablet?.lastSeen > Date.now()-30000) {
        await session.ref.update({stopRequested:true});
        res.json({requested:true});return;
      }
      res.json(await finish(sessionId));return;
    }
    const tablet = await device(req,deviceCode);
    if (action === 'poll') {
      await tablet.ref.update({lastSeen:Date.now()});
      const session = tablet.sessionId ? await getSession(tablet.sessionId,deviceCode) : null;
      // Only the minimum patient identity and this device's own transcript are exposed.
      res.json({session:session ? {id:tablet.sessionId,status:session.status,stopRequested:Boolean(session.stopRequested),patient:{name:session.patient.name,patientId:session.patient.patientId,age:session.patient.age,sex:session.patient.sex},transcript:['waiting','active','ending'].includes(session.status) ? session.transcript || [] : []} : null});return;
    }
    const session = await getSession(sessionId,deviceCode);
    if (action === 'end-empty') {
      await abandonEmptySession(db,sessionId);res.json({ended:true});return;
    }
    if (action === 'checkpoint') {
      await checkpoint(sessionId,body.transcript);res.json({saved:true});return;
    }
    if (action === 'finish') {
      await checkpoint(sessionId,body.transcript);
      res.json(await finish(sessionId));return;
    }
    if (action === 'token') {
      const systemInstruction = interviewPromptForLanguage(body.language || 'auto');
      await db.runTransaction(async tx => {
        const snapshot = await tx.get(session.ref);
        const s = snapshot.data();
        if (!['waiting','active'].includes(s.status) || (s.connections || 0) >= 10) throw new Error('This conversation cannot be started again. Ask staff for help.');
        tx.update(session.ref,{status:'active',connections:(s.connections || 0)+1});
      });
      const liveConfig = {responseModalities:['AUDIO'],inputAudioTranscription:{},outputAudioTranscription:{},speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:'Aoede'}}},systemInstruction};
      const model = 'gemini-3.8-live';
      const ai = new GoogleGenAI({apiKey:key.value(),httpOptions:{apiVersion:'v1beta'}});
      const token = await ai.authTokens.create({config:{uses:1,expireTime:new Date(Date.now()+30*60000).toISOString(),newSessionExpireTime:new Date(Date.now()+60000).toISOString(),liveConnectConstraints:{model,config:liveConfig}}});
      res.json({token:token.name,model,liveConfig});return;
    }
    throw new Error('Unknown action.');
  } catch (error) {
    // Do not log patient history, tokens, or model responses.
    const message = String(error.message || 'Doctor Assistant failed.');
    const safe = /^(Staff |Patient |Another |This |Conversation |No patient|Invalid |Session |Choose |An entry|The assistant)/.test(message);
    res.status(400).json({error:safe ? message : 'Doctor Assistant could not complete this step. Your session remains available; please retry or ask staff for help.'});
  }
});
