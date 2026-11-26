const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createClient, validate, prestige} = require('../prestige-sync.js');

const fixture = () => ({data: Array.from({length: 200}, (_, i) => ({
  id: i + 1, name: i ? `Champion ${i}` : 'Doctor Doom',
  rarity: [6, 7], pi: 40150, pi_74: 33880, ascend: true
}))});
const reply = data => ({ok: true, json: async () => data});
const memory = () => {let saved; return {getItem: () => saved, setItem: (_, value) => {saved = value;}};};

test('matches mcoc.gg rounding for all six values; no ascension when unavailable', () => {
  assert.deepEqual(prestige(validate(fixture())[0]), {
    r4_base:33880,r4_a1:36590,r4_a2:39520,r5_base:40150,r5_a1:43360,r5_a2:46830
  });
  const payload = fixture(); payload.data[0].ascend = false;
  assert.equal(prestige(validate(payload)[0]).r5_a2,0);
  payload.data[0].rarity = [6];
  assert.ok(Object.values(prestige(validate(payload)[0])).every(v => v === 0));
});

test('English and Spanish aliases update when the upstream prestige changes', async () => {
  let payload=fixture(); let calls=0;
  const client=createClient({storage:memory(), aliases:{'doctor doom':['Doctor Muerte']}, fetch:async (url,opts) => {
    calls++; assert.match(url,/^https:\/\/mcoc.gg\/json\/champions.json\?theshori=\d+$/);
    assert.equal(opts.credentials,'omit'); assert.equal(opts.cache,'no-store'); return reply(payload);
  }});
  await client.refresh();
  assert.equal(client.get('DOCTOR MUERTE').r5_a2,46830);
  payload=fixture(); payload.data[0].pi=42000;
  await client.refresh();
  assert.equal(client.get('Doctor Doom').r5_base,42000);
  assert.equal(client.get('Doctor Muerte').r5_a2,48990);
  assert.equal(client.get('Unknown'),null); assert.equal(calls,2);
  const returned=client.get('Doctor Doom'); returned.r5_base=1;
  assert.equal(client.get('Doctor Doom').r5_base,42000);
});

test('network, partial payloads, malformed values and aliases preserve last good data', async () => {
  let payload=fixture(); let offline=false;
  const client=createClient({storage:memory(), fetch:async()=>{if(offline)throw Error('offline');return reply(payload);}});
  await client.refresh(); const before=client.get('Doctor Doom'); const timestamp=client.getState().updatedAt;
  offline=true; await client.refresh(); assert.deepEqual(client.get('Doctor Doom'),before);
  offline=false; payload={data:[]}; await client.refresh(); assert.deepEqual(client.get('Doctor Doom'),before);
  payload=fixture(); payload.data[0].pi='invalid'; await client.refresh(); assert.deepEqual(client.get('Doctor Doom'),before);
  assert.equal(client.getState().updatedAt,timestamp); assert.equal(client.getState().fresh,false);
  assert.ok(client.getState().error);
  payload=fixture(); payload.data[1].id=payload.data[0].id;
  assert.throws(()=>validate(payload),/Invalid/);
  payload=fixture(); payload.data[0].ascend='yes'; assert.throws(()=>validate(payload),/Invalid/);
});

test('overlapping refreshes share a request and storage failures are harmless', async () => {
  let calls=0,resolve;
  const client=createClient({storage:{setItem(){throw Error('blocked');}},fetch:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const one=client.refresh(); const two=client.refresh();
  resolve(reply(fixture())); await Promise.all([one,two]);
  assert.equal(calls,1); assert.equal(client.getState().fresh,true);
});

test('last good cache loads on a later visit and timers/listeners are cleaned up', async () => {
  const storage=memory();
  const client=createClient({storage,fetch:async()=>reply(fixture())}); await client.refresh();
  let listeners=0;
  global.document={visibilityState:'visible',addEventListener(){listeners++;},removeEventListener(){listeners--;}};
  let changed;
  const done=new Promise(r=>{changed=r;});
  const restored=createClient({storage,fetch:async()=>{throw Error('offline');},onChange:state=>{if(state.error)changed();}});
  restored.start(); restored.start();
  assert.equal(restored.get('Doctor Doom').r5_a2,46830);
  await done; assert.equal(restored.getState().fresh,false); assert.equal(listeners,1);
  restored.stop(); assert.equal(listeners,0); delete global.document;
});

test('visible pages refresh every five minutes and resume after a hidden tab', async () => {
  const originalInterval=global.setInterval, originalClear=global.clearInterval, originalNow=Date.now;
  let tick, resume, intervalMs, calls=0, payload=fixture();
  global.setInterval=(fn,ms)=>{tick=fn;intervalMs=ms;return 1;}; global.clearInterval=()=>{};
  global.document={visibilityState:'visible',addEventListener(_,fn){resume=fn;},removeEventListener(){}};
  const client=createClient({storage:null,fetch:async()=>{calls++;return reply(payload);}});
  try {
    client.start(); await client.refresh();
    assert.equal(calls,1); assert.equal(intervalMs,300000);
    Date.now=()=>originalNow()+300001;
    global.document.visibilityState='hidden'; tick(); assert.equal(calls,1);
    payload=fixture(); payload.data[0].pi=42000;
    global.document.visibilityState='visible'; resume(); await client.refresh();
    assert.equal(calls,2); assert.equal(client.get('Doctor Doom').r5_base,42000);
    tick(); await client.refresh(); assert.equal(calls,3);
  } finally {
    client.stop(); global.setInterval=originalInterval; global.clearInterval=originalClear;
    Date.now=originalNow; delete global.document;
  }
});
