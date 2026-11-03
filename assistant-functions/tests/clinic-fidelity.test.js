import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const start=html.indexOf('      function clinicalFidelityRules()');
const end=html.indexOf('      function blobToBase64(',start);
const context=vm.createContext({patientDisplayId:p=>p.patientId});
vm.runInContext(html.slice(start,end),context);

test('all dictation modes forbid generated diagnoses and preserve bilingual per-dose amounts',()=>{
  context.patient={name:'Synthetic Patient',patientId:'TEST',diagnosis:'UNCONFIRMED_CATEGORY'};
  for(const mode of ['visit','prescription','addon','reply','certificate']){
    context.mode=mode;
    const prompt=vm.runInContext('ambientPrompt(patient,mode)',context);
    assert.match(prompt,/Do not generate a diagnosis/);
    assert.match(prompt,/1 gram PER DOSE twice daily, NOT 500 mg/);
    assert.match(prompt,/noon dose MUST remain 1\/2, never 1/);
    assert.match(prompt,/ഉച്ചയ്ക്ക് 1\/2 ഗുളിക/);
    assert.match(prompt,/Do not invent clock times or tablet counts/);
    assert.doesNotMatch(prompt,/UNCONFIRMED_CATEGORY/);
    assert.doesNotMatch(prompt,/write exactly "Take 1 tablet SOS/);
    assert.doesNotMatch(prompt,/evening.*write it as night/);
  }
  assert.match(html,/parts: \[\{ text: `\$\{clinicalFidelityRules\(\)\}/);
});

test('clinic entrypoints retire assistant controls without removing historical note rendering',()=>{
  assert.equal(fs.existsSync(new URL('../../patient.html',import.meta.url)),false);
  assert.doesNotMatch(html,/doctorAssistantButton|installDoctorAssistant|pairPatientDeviceBtn/);
  assert.match(html,/Assistant Note/);
  assert.equal(fs.readFileSync(new URL('../../clinic-layout.html',import.meta.url),'utf8'),html);
});
