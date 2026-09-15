import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserSessionsService } from '../src/main/browserSessions.ts'
import { parseBrowserSelection } from '../src/shared/browserSessions.ts'
import { probeMedia } from '../src/renderer/src/lib/store.ts'

function fixture(profile = {}) {
  const state = { profile: { info_cache: { Default: { user_name: 'never expose', email: 'private@example.test', name: '用户 1' }, 'Profile 1': {name:'工作\u0000资料'} }, last_used: 'Default', last_active_profiles: ['Profile 1'], ...profile } }
  const checked = []
  return { state, checked, service: new BrowserSessionsService({ localState: async () => state, hasCookies: async (_browser, id) => { checked.push(id); return true } }) }
}
test('automatic selection uses Chrome active metadata, never most recently modified cookie DB or account labels', async () => {
  const { service } = fixture()
  const result = await service.catalog('chrome')
  assert.equal(result.source.selector, 'chrome:Profile 1')
  assert.equal(result.source.selection, 'automatic')
  assert.equal(result.source.label, 'Chrome · 工作资料')
  assert.equal(result.profiles.find(value => value.id === 'Profile 1').current, true)
  assert.doesNotMatch(JSON.stringify(result), /private@example.test|never expose|user_name|email/)
})
test('explicit profile remains fixed when browser current profile changes', async () => {
  const { state, service } = fixture()
  const selected = await service.resolve('chrome')
  state.profile.last_active_profiles = ['Default']
  assert.equal((await service.resolve(selected.selector)).selector, 'chrome:Profile 1')
  assert.equal((await service.resolve('chrome')).selector, 'chrome:Default')
})
test('multiple active profiles and missing active profile require choice instead of Default fallback', async () => {
  const many = fixture({ last_active_profiles: ['Default', 'Profile 1'] })
  assert.equal((await many.service.catalog('chrome')).code, 'profileSelectionRequired')
  const service = new BrowserSessionsService({ localState: async () => many.state, hasCookies: async (_browser, profile) => profile === 'Default' })
  many.state.profile.last_active_profiles = ['Profile 1']
  assert.equal((await service.catalog('chrome')).source, undefined)
  assert.equal((await service.catalog('chrome:Profile 1')).source, undefined)
  assert.equal((await service.resolve('chrome:Default')).selector, 'chrome:Default')
})
test('missing or malformed Local State and arbitrary profile paths never expand scope', async () => {
  for (const value of ['chrome:/tmp/account', 'chrome:../Default', 'chrome:Default\n', 'chrome:Profile 0', 'chrome:Default:container', 'firefox:Default', '', 1]) assert.equal(parseBrowserSelection(value), null)
  for (const state of [null, {}, {profile:{}}, {profile:{info_cache:{'../private':{}},last_active_profiles:['../private']}}]) {
    const calls = []
    const service = new BrowserSessionsService({localState:async()=>state,hasCookies:async(...value)=>{calls.push(value);return true}})
    assert.equal((await service.catalog('chrome')).source, undefined)
    assert.equal(calls.length, 0)
  }
})
test('one anonymous login-required probe retries only the resolved profile and returns it for durable creation', async () => {
  const calls = [], selections = []
  globalThis.window = { localStorage:{getItem:()=>null},ndm:{
    browserSessions:async selection=>{selections.push(selection);return {source:{selector:'chrome:Profile 1',label:'Chrome · 个人资料 1'}}},
    request:async(op,extra)=>{calls.push(extra);return calls.length===1?{ok:false,errorKind:'browserSessionRequired'}:{ok:true,formats:[{id:'720p'}]}}
  }}
  const result = await probeMedia('https://video.example.test/watch')
  assert.deepEqual(selections,['chrome'])
  assert.equal(calls.length,2)
  assert.equal(calls[0].cookieBrowser,undefined)
  assert.equal(calls[1].cookieBrowser,'chrome:Profile 1')
  assert.equal(result.cookieBrowser,'chrome:Profile 1')
  assert.match(result.sessionSourceLabel,/个人资料 1/)
})
test('Relay source skips profile discovery even after login-required failure', async () => {
  let requests = 0
  globalThis.window = {ndm:{browserSessions:async()=>{assert.fail('Relay must retain the source page profile')},request:async(_op,extra)=>{requests++;assert.equal(extra.browserSessionID,'relay-id');return {ok:false,errorKind:'browserSessionRequired'}}}}
  await probeMedia('https://video.example.test/watch','chrome','relay-id','chrome')
  assert.equal(requests,1)
})
test('failed source discovery never sends an unqualified browser to the engine', async () => {
  globalThis.window={localStorage:{getItem:()=>null},ndm:{browserSessions:async()=>({error:'请选择当前登录的个人资料'}),request:async()=>{assert.fail('No anonymous or another-profile fallback')}}}
  const result=await probeMedia('https://video.example.test/watch','chrome')
  assert.equal(result.errorKind,'browserDataUnavailable')
  assert.equal(result.errorMessage,'请选择当前登录的个人资料')
})
test('a failed authenticated probe returns its bound source for retry after Chrome switches profiles', async () => {
  const {state,service}=fixture(), choices=[]
  globalThis.window={localStorage:{getItem:()=>null},ndm:{
    browserSessions:selection=>service.catalog(selection),
    request:async(_op,options)=>{choices.push(options.cookieBrowser);return {ok:false,errorKind:'browserSessionRequired',error:'请在同一资料中重新登录'}}
  }}
  const first=await probeMedia('https://video.example.test/watch','chrome')
  assert.equal(first.cookieBrowser,'chrome:Profile 1')
  assert.match(first.errorMessage,/工作资料.*重新登录/)
  state.profile.last_active_profiles=['Default']
  const retry=await probeMedia('https://video.example.test/watch',first.cookieBrowser)
  assert.equal(retry.cookieBrowser,'chrome:Profile 1')
  assert.deepEqual(choices,['chrome:Profile 1','chrome:Profile 1'])
})
