const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeOptions, sanitizeSettings, musicSubmissionOptions, paidMusicRequested, musicReviewKey, buildJobPayload} = require('../../backlot/ui/footage.js');
const payload = () => ({project_id:'isolated', action:'render', stop_at:'video', shots:[{id:'one',duration_seconds:6}], options:{bgm_mode:'elevenlabs',bgm_prompt:'温暖的江南器乐，古筝与弦乐',bgm_model_id:'music_v2_5'}});
test('real model and description survive ordinary config; consent never survives normalization/export', () => {
  const options = normalizeOptions({...payload().options,bgm_confirm_paid:true,bgm_confirm_text:true,bgm_billing_limit_configured:true,bgm_budget_usd:1});
  assert.equal(options.bgm_model_id,'music_v2_5'); assert.equal(options.bgm_prompt,payload().options.bgm_prompt);
  assert.equal(Object.keys(options).some(k=>/confirm|budget|billing/.test(k)),false);
  assert.throws(()=>sanitizeSettings({...options,bgm_confirm_paid:true}),/不在允许范围/);
  assert.deepEqual(sanitizeSettings(options),options);
});
test('collect and every earlier stage never carry payment approval even when ElevenLabs is selected', () => {
  for (const action of ['collect','create','render']) for (const stop_at of ['script','terms','materials','audio','subtitle','video']) {
    const item={...payload(),action,stop_at}; const required=action!=='collect'&&stop_at==='video';
    assert.equal(paidMusicRequested(item),required);
    if (!required) assert.equal(musicSubmissionOptions(item,{paid:true,text:true,billing:true,budget:1}).bgm_confirm_paid,undefined);
  }
});
test('one-job approval requires all three confirmations and a positive finite budget', () => {
  for(const value of [{},{paid:true,text:true,billing:false,budget:1},{paid:true,text:true,billing:true,budget:0},{paid:true,text:true,billing:true,budget:Infinity}]) assert.throws(()=>musicSubmissionOptions(payload(),value),/预算/);
  const submitted=musicSubmissionOptions(payload(),{paid:true,text:true,billing:true,budget:.2});
  assert.equal(submitted.bgm_budget_usd,.2); assert.equal(submitted.bgm_confirm_paid,true);
  assert.equal(buildJobPayload({...payload(), options:submitted}).options.bgm_confirm_paid,undefined);
});
test('review invalidates when project, description, model, shot timing or narration changes', () => {
  const item=payload(), original=musicReviewKey(item);
  for(const changed of [{...item,project_id:'other'},{...item,options:{...item.options,bgm_mode:'local'}},{...item,options:{...item.options,bgm_prompt:'另一首音乐'}},{...item,options:{...item.options,bgm_model_id:'music_v1'}},{...item,shots:[{id:'one',duration_seconds:7}]},{...item,options:{...item.options,narration:'local'}}]) assert.notEqual(musicReviewKey(changed),original);
});
