import test from 'node:test';
import assert from 'node:assert/strict';
import {interviewPromptForLanguage, notePrompt} from '../prompts.js';

test('fixed reply language accepts multilingual input without following its language', () => {
  assert.match(interviewPromptForLanguage('ml'), /Reply ONLY in Malayalam/);
  assert.match(interviewPromptForLanguage('ml'), /never switch your replies to English/);
  assert.match(interviewPromptForLanguage('en'), /Reply ONLY in English/);
  assert.match(interviewPromptForLanguage('en'), /never switch your replies to Malayalam/);
  assert.match(interviewPromptForLanguage('auto'), /follow the patient's preferred language/);
  assert.throws(() => interviewPromptForLanguage('unexpected'), /Invalid response language/);
  for (const language of ['ml','en','auto']) {
    assert.match(interviewPromptForLanguage(language), /Do not repeat or paraphrase the patient's answers/);
    assert.match(interviewPromptForLanguage(language), /Ask for clarification when speech is unclear/);
  }
});

test('referral opens the interview and optional expectations and concerns close it',()=>{
  for(const language of ['ml','en','auto']){
    const prompt=interviewPromptForLanguage(language);
    assert.match(prompt,/Are you referred by a doctor\?/);
    assert.ok(prompt.indexOf('REFERRAL:')<prompt.indexOf('നിങ്ങളുടെ ആരോഗ്യപ്രശ്നങ്ങൾ എന്തൊക്കെയാണെന്ന്'));
    assert.ok(prompt.indexOf('CLOSING:')>prompt.indexOf('BRIEF FOLLOW-UP:'));
    assert.match(prompt,/What are you hoping for from today's consultation\?/);
    assert.match(prompt,/What concerns you most about your health problem\?/);
    assert.match(prompt,/If the patient wants to finish early, respect that/);
  }
  assert.match(notePrompt,/Within historyOfPresentIllness, include clearly labelled Referral, Expectations, and Concerns/);
  assert.match(notePrompt,/Do not infer referral status/);
});

test('patient-led interview opens gently and never pressures patients to complete a checklist',()=>{
  for(const language of ['ml','en','auto']){
    const prompt=interviewPromptForLanguage(language);
    assert.match(prompt,/ഡോക്ടറെ കാണുന്നതിന് മുമ്പ്/);
    assert.match(prompt,/Do not ask their name again/);
    assert.match(prompt,/let the patient describe their full story/);
    assert.match(prompt,/Only after the main account is finished/);
    assert.match(prompt,/Do not force the patient to answer/);
    assert.match(prompt,/Uncollected details must remain Not reported/);
  }
});
