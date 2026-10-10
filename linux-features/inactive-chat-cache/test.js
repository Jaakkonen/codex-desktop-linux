"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { maximum, prepare, protectDispatch, scopeMaximum, prepareScopes, apply } = require("./patch.js");

const scopes = 'var thread=scope(`ThreadScope`,{key:e=>e.clientThreadId,parent:root,retain:{max:20}}),route=scope(`RouteScope`,{key:routeKey,parent:thread,retain:{max:20}});';
const source = 'var k=108e5,l=15e3,m=10,C=class{params;inactiveOwnerConversationSinceById=new Map;' +
  'getInactiveOwnerConversationIdsToUnsubscribe(e){let t=[];for(let[n,r]of this.inactiveOwnerConversationSinceById.entries()){' +
  'if(this.unsubscribingConversationIds.has(n))continue;let i=this.params.threadStore.getConversation(n);' +
  'if(i?.resumeState!==`resumed`||!this.params.streamState.ownsConversationHistoryStream(n)||this.hasActiveConversationView(n)||this.hasOwnedStreamFollowers(n)||this.shouldKeepConversationLoaded(i))continue;' +
  'let a=this.inactiveOwnerConversationRetryAtById.get(n)??null;a!=null&&a>e||t.push({conversationId:n,inactiveSinceMs:r,isEphemeralSideConversation:tx(i),ttlExpired:e-r>=k})}' +
  't.sort((e,t)=>e.inactiveSinceMs-t.inactiveSinceMs);let n=t.filter(e=>!e.isEphemeralSideConversation),r=Math.max(0,n.length-m),i=new Set(n.slice(0,r)),a=t.filter(e=>e.ttlExpired||i.has(e)).map(e=>e.conversationId);' +
  'return a.length>0&&this.params.logger.debug(`inactive_thread_unsubscribe_candidates_evaluated`,{safe:{candidateCount:t.length,conversationIdsToUnsubscribe:a,maxInactiveOwnerThreads:m,overage:r,ttlMs:k},sensitive:{}}),a}' +
  'async unsubscribeInactiveConversation(e){if(this.unsubscribingConversationIds.has(e))return;let t=this.params.threadStore.getConversation(e),n=this.params.streamState.getStreamRole(e)?.role??null;if(t?.resumeState!==`resumed`||!this.params.streamState.ownsConversationHistoryStream(e)){return}this.unsubscribingConversationIds.add(e);return this.params.requestClient.sendRequest(`thread/unsubscribe`,{threadId:e})}};';

test("opt-in preserves upstream default and validates numeric settings", () => {
  assert.equal(maximum(), 10);
  for (const value of [-1, 11, 2.5, '2', null]) {
    assert.throws(() => maximum({feature:{settings:{maximumInactiveOwners:value}}}));
  }
  assert.equal(prepare(source, 10), protectDispatch(source));
});

test("changes count and final activity guard and is idempotent", () => {
  const patched = prepare(source, 2);
  assert.equal(patched, protectDispatch(source).replace('m=10,C=class', 'm=2,C=class'));
  assert.equal(prepare(patched, 2), patched);
  assert.equal(prepare(source.replace(/\bm\b/g, 'count'), 2),
    protectDispatch(source.replace(/\bm\b/g, 'count')).replace('count=10,C=class', 'count=2,C=class'));
});

test("native selector evicts oldest eligible owners and preserves exclusions", () => {
  const cls = new Function('tx', prepare(source, 2) + 'return C;')(t=>t.ephemeral);
  const instance = new cls();
  const records = new Map(Array.from({length:10},(_,i)=>['idle'+i,{resumeState:'resumed'}]));
  for (const id of ['view','followers','keep','nonowner','needsResume']) {
    records.set(id, {resumeState:id==='needsResume'?'needs_resume':'resumed',id});
  }
  instance.params={threadStore:{getConversation:id=>records.get(id)},streamState:{ownsConversationHistoryStream:id=>id!=='nonowner'},logger:{debug(){}}};
  instance.inactiveOwnerConversationSinceById=new Map([...records.keys()].map((id,i)=>[id,i*100]));
  instance.inactiveOwnerConversationRetryAtById=new Map();
  instance.unsubscribingConversationIds=new Set();
  instance.hasActiveConversationView=id=>id==='view';
  instance.hasOwnedStreamFollowers=id=>id==='followers';
  instance.shouldKeepConversationLoaded=t=>t.id==='keep';
  assert.deepEqual(instance.getInactiveOwnerConversationIdsToUnsubscribe(5000),Array.from({length:8},(_,i)=>'idle'+i));
  instance.inactiveOwnerConversationRetryAtById.set('idle0',6000);
  assert.deepEqual(instance.getInactiveOwnerConversationIdsToUnsubscribe(5000),Array.from({length:7},(_,i)=>'idle'+(i+1)));
});

test("rejects drift, duplicates and lost activity safeguards", () => {
  assert.throws(()=>prepare(source+source,2));
  assert.throws(()=>prepare(source.replace('m=10','m=12'),2));
  assert.throws(()=>prepare(source.replace('108e5','108e6'),2));
  assert.throws(()=>prepare(source.replace('this.hasOwnedStreamFollowers(n)||',''),2));
});

test("qualifies both bundles before mutation", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inactive-chat-cache-'));
  try {
    for (const folder of ['.vite/build','webview/assets']) fs.mkdirSync(path.join(dir,folder),{recursive:true});
    const main=path.join(dir,'.vite/build/renamed.js'), view=path.join(dir,'webview/assets/renamed.js');
    fs.writeFileSync(main,source);fs.writeFileSync(view,'unrecognized');
    assert.throws(()=>apply(dir,{feature:{settings:{maximumInactiveOwners:2}}}));
    assert.equal(fs.readFileSync(main,'utf8'),source);
    fs.writeFileSync(view,source + scopes);
    assert.deepEqual(apply(dir,{feature:{settings:{maximumInactiveOwners:2}}}),{matched:2,changed:2,maximumInactiveOwners:2});
    assert.equal(apply(dir,{feature:{settings:{maximumInactiveOwners:2}}}).changed,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test("rechecks activity acquired between selection and unsubscribe dispatch", async () => {
  async function dispatch(bundle, protectedState) {
    const C = new Function('tx', bundle + 'return C;')(() => false);
    const instance = new C();
    let sent = 0;
    instance.params = {
      threadStore: {getConversation: () => ({resumeState: 'resumed'})},
      streamState: {getStreamRole: () => ({role: 'owner'}), ownsConversationHistoryStream: () => true},
      requestClient: {sendRequest: async () => {sent++;}},
    };
    instance.unsubscribingConversationIds = new Set();
    instance.hasActiveConversationView = () => protectedState === 'view';
    instance.hasOwnedStreamFollowers = () => protectedState === 'followers';
    instance.shouldKeepConversationLoaded = () => protectedState === 'keep';
    await instance.unsubscribeInactiveConversation('selected-before-activity');
    return sent;
  }
  assert.equal(await dispatch(source, 'view'), 1, 'reproduces upstream dispatch race');
  for (const state of ['view', 'followers', 'keep']) {
    assert.equal(await dispatch(prepare(source, 2), state), 0);
  }
  assert.equal(await dispatch(prepare(source, 2), 'idle'), 1);
});


test("does not touch unrelated unsubscribe methods in other classes", () => {
  const other = 'var Other=class{async unsubscribeInactiveConversation(e){return e}};';
  assert.equal(prepare(source + other, 2), prepare(source, 2) + other);
});


test("bounds both native scope caches without changing mounted-view safeguards", () => {
  assert.equal(scopeMaximum(), 20);
  for (const value of [-1, 21, 1.5, "2", null]) {
    assert.throws(() => scopeMaximum({feature:{settings:{maximumRetainedScopes:value}}}));
  }
  const patched = prepareScopes(scopes, 2);
  assert.equal(patched, scopes.replaceAll("max:20", "max:2"));
  assert.equal(prepareScopes(patched, 2), patched);
  assert.throws(() => prepareScopes(scopes + scopes, 2));
  assert.throws(() => prepareScopes(scopes.replace("RouteScope", "ChangedScope"), 2));
  assert.throws(() => prepareScopes(scopes.replace("max:20", "max:21"), 2));
});
