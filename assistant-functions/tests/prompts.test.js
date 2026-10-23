import test from 'node:test';
import assert from 'node:assert/strict';
import {interviewPromptForLanguage} from '../prompts.js';

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
