import { expect, test, vi } from 'vitest'

import { createNativeSshOwnerClient } from './ssh-native-owner'

const endpoint = { profile_id: '/home/ubuntu/.hermes', instance_id: 'owner-one', api_origin: 'http://127.0.0.1:4567', runtime_protocol: 1 as const }
const bootstrap = JSON.stringify(['/usr/bin/python3', '-I', '-c', "import sys, runpy; runpy.run_module('run_agent',run_name='__main__')"])
function transport(replies: unknown[]) {
  const exec = vi.fn().mockResolvedValueOnce(bootstrap)
  for (const reply of replies) {exec.mockResolvedValueOnce(typeof reply === 'string' ? reply : JSON.stringify(reply))}
  return { exec }
}

test('a UI burst bounds SSH exchanges to three and mints a distinct grant per request', async () => {
  let active = 0, peak = 0, issued = 0, bootstraps = 0
  const ssh = { exec: vi.fn(async command => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    if (command.includes('--print-runtime-command')) { bootstraps++; return bootstrap }
    return JSON.stringify({ ok: true, endpoint, ticket: `test-${++issued}` })
  }) }
  const client = createNativeSshOwnerClient(ssh, '/usr/bin/hermes')
  const grants = await Promise.all(Array.from({ length: 12 }, () => client.mint('default', 'native-http', endpoint)))
  expect(peak).toBe(3)
  expect(bootstraps).toBe(1)
  expect(new Set(grants).size).toBe(12)
  expect(ssh.exec).toHaveBeenCalledTimes(13)
  await client.close()
})

test('closing during bootstrap drains the active call and cancels queued exchanges before SSH', async () => {
  let release!: (value:string)=>void
  const ssh = { exec: vi.fn(() => new Promise<string>(resolve => { release = resolve })) }
  const client = createNativeSshOwnerClient(ssh, '/usr/bin/hermes')
  const pending = Promise.allSettled([client.discover('default'), client.mint('default', 'native-http', endpoint)])
  await vi.waitFor(() => expect(ssh.exec).toHaveBeenCalledTimes(1))
  let closed = false
  const closing = client.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  release(bootstrap)
  expect((await pending).every(result => result.status === 'rejected')).toBe(true)
  await closing
  expect(ssh.exec).toHaveBeenCalledTimes(1)
  await expect(client.discover('default')).rejects.toThrow('closed or busy')
})

test('pending control work is bounded and closing does not execute queued requests', async () => {
  let release!: (value:string)=>void
  const ssh = { exec: vi.fn(() => new Promise<string>(resolve => { release = resolve })) }
  const client = createNativeSshOwnerClient(ssh, '/usr/bin/hermes')
  const pending = Promise.allSettled(Array.from({ length: 64 }, () => client.discover('default')))
  await expect(client.discover('default')).rejects.toThrow('closed or busy')
  const closing = client.close()
  release(bootstrap)
  await closing
  expect((await pending).every(result => result.status === 'rejected')).toBe(true)
  expect(ssh.exec).toHaveBeenCalledTimes(1)
})

test('a failed shared bootstrap is not repeated by concurrent control requests', async () => {
  const ssh={exec:vi.fn().mockRejectedValue(new Error('PRIVATE_SENTINEL'))}
  const client=createNativeSshOwnerClient(ssh,'/usr/bin/hermes')
  const results=await Promise.allSettled(Array.from({length:6},()=>client.discover('default')))
  expect(results.every(result=>result.status==='rejected'&&!String(result.reason).includes('PRIVATE_SENTINEL'))).toBe(true)
  expect(ssh.exec).toHaveBeenCalledTimes(1)
  await client.close()
})

test('close drains all three active controls and never starts queued work', async () => {
  const release:((value:string)=>void)[]=[]
  const ssh={exec:vi.fn(command=>command.includes('--print-runtime-command')?Promise.resolve(bootstrap):new Promise<string>(resolve=>release.push(resolve)))}
  const client=createNativeSshOwnerClient(ssh,'/usr/bin/hermes')
  const results=Promise.allSettled(Array.from({length:5},()=>client.discover('default')))
  await vi.waitFor(()=>expect(release).toHaveLength(3))
  let closed=false
  const closing=client.close().then(()=>{closed=true})
  release[0](JSON.stringify({ok:true,endpoint}));release[1](JSON.stringify({ok:true,endpoint}))
  await Promise.resolve()
  expect(closed).toBe(false)
  release[2](JSON.stringify({ok:true,endpoint}))
  await closing
  const settled=await results
  expect(settled.filter(result=>result.status==='rejected')).toHaveLength(2)
  expect(ssh.exec).toHaveBeenCalledTimes(4)
})

test('discovers through installed SSH runtime without starting or persisting an owner', async () => {
  const ssh = transport([{ ok: true, endpoint }])
  const client = createNativeSshOwnerClient(ssh, '/home/ubuntu/.local/bin/hermes')
  expect(await client.discover('default')).toEqual(endpoint)
  expect(ssh.exec).toHaveBeenCalledTimes(2)
  expect(ssh.exec.mock.calls[0][0]).toContain('--print-runtime-command --module run_agent')
  expect(ssh.exec.mock.calls[1][1].stdinData).not.toContain('ensure_gateway_runtime')
})

test('requests a fresh ticket each time and does not return it from discovery', async () => {
  const ssh = transport([{ ok: true, endpoint }, { ok: true, endpoint, ticket: 'ticket-one' }, { ok: true, endpoint, ticket: 'ticket-two' }])
  const client = createNativeSshOwnerClient(ssh, '/home/ubuntu/.local/bin/hermes')
  const found = await client.discover('default')
  expect(found).not.toHaveProperty('ticket')
  expect(await client.mint('default', 'interactive', found)).toBe('ticket-one')
  expect(await client.mint('default', 'interactive', found)).toBe('ticket-two')
  expect(ssh.exec).toHaveBeenCalledTimes(4)
})

test('an owner restart refuses the ticket rather than reconnecting or falling back', async () => {
  const ssh = transport([{ ok: true, endpoint: { ...endpoint, instance_id: 'owner-two' }, ticket: 'private-ticket' }])
  const client = createNativeSshOwnerClient(ssh, '/home/ubuntu/.local/bin/hermes')
  await expect(client.mint('default', 'interactive', endpoint)).rejects.toThrow('identity changed')
  expect(ssh.exec).toHaveBeenCalledTimes(2)
})

test('refusals and transport errors never expose private server output', async () => {
  const ssh = transport([{ ok: false, reason: 'denied', ticket: 'PRIVATE_SENTINEL' }])
  const client = createNativeSshOwnerClient(ssh, '/home/ubuntu/.local/bin/hermes')
  await expect(client.discover('default')).rejects.toThrow('no fallback')
  expect(ssh.exec).toHaveBeenCalledTimes(2)
  const failing = { exec: vi.fn().mockRejectedValue(new Error('PRIVATE_SENTINEL')) }
  await expect(createNativeSshOwnerClient(failing, '/usr/bin/hermes').discover('default')).rejects.not.toThrow('PRIVATE_SENTINEL')
})

test('a foreign profile or endpoint cannot substitute for a ticket owner', async () => {
  for (const changed of [{ profile_id: '/home/ubuntu/.hermes/profiles/mira' }, { api_origin: 'http://127.0.0.1:9999' }]) {
    const ssh = transport([{ ok: true, endpoint: { ...endpoint, ...changed }, ticket: 'private-ticket' }])
    await expect(createNativeSshOwnerClient(ssh, '/usr/bin/hermes').mint('default', 'native-http', endpoint)).rejects.toThrow('identity changed')
  }
})

test('nonloopback owners and unknown ticket purposes fail closed', async () => {
  const ssh = transport([{ ok: true, endpoint: { ...endpoint, api_origin: 'https://outside.example' } }])
  await expect(createNativeSshOwnerClient(ssh, '/usr/bin/hermes').discover('default')).rejects.toThrow('origin')
  const empty = { exec: vi.fn() }
  await expect(createNativeSshOwnerClient(empty, '/usr/bin/hermes').mint('default', 'invalid' as never, endpoint)).rejects.toThrow('purpose')
  expect(empty.exec).not.toHaveBeenCalled()
})

test('profile data goes through private stdin, not the shell command', async () => {
  const ssh = transport([{ ok: false, reason: 'invalid_profile' }])
  await expect(createNativeSshOwnerClient(ssh, '/usr/bin/hermes').discover('not-a-profile; touch /tmp/NOT_ALLOWED')).rejects.toThrow('no fallback')
  expect(ssh.exec.mock.calls[1][0]).not.toContain('NOT_ALLOWED')
  expect(ssh.exec.mock.calls[1][1].stdinData).toContain('NOT_ALLOWED')
})

test('unrecognized installed bootstrap is refused before a request is transmitted', async () => {
  const ssh = { exec: vi.fn().mockResolvedValue(JSON.stringify(['/usr/bin/python3', '-c', 'print(1)'])) }
  await expect(createNativeSshOwnerClient(ssh, '/usr/bin/hermes').discover('default')).rejects.toThrow('no fallback')
  expect(ssh.exec).toHaveBeenCalledTimes(1)
})

test('the Python edge preserves native profile and refusal checks without live runtime access', async () => {
  const { spawnSync } = await import('node:child_process')
  const { NATIVE_SSH_SCRIPT } = await import('./ssh-native-owner')
  const code = `
import json, sys, types
from pathlib import Path
from types import SimpleNamespace as NS
script = json.load(sys.stdin)['script']
calls = []
ctx = NS(state='ready', endpoint=NS(profile_id='/home/ubuntu/.hermes', instance_id='one', api_origin='http://127.0.0.1:4567', runtime_protocol=1))
package = types.ModuleType('hermes_cli'); package.__path__ = []
profiles = types.ModuleType('hermes_cli.profiles')
class Home:
    def __init__(self,name): self.name=name
    def resolve(self,strict=True): return self
    def __str__(self): return '/home/ubuntu/.hermes' + ('' if self.name=='default' else '/profiles/'+self.name)
profiles.get_profile_dir = lambda name: (calls.append(('profile', name)) or Home(name))
runtime = types.ModuleType('hermes_cli.gateway_runtime')
runtime.discover_gateway_endpoint = lambda home: NS(state=ctx.state, endpoint=ctx.endpoint)
runtime.attachable = lambda found: found.state == 'ready'
client = types.ModuleType('hermes_cli.gateway_client')
def mint(home, endpoint, **kw):
    calls.append(('ticket', kw)); return 'fake-test-ticket'
client._session_ticket = mint
for name, module in [('hermes_cli',package), ('hermes_cli.profiles',profiles), ('hermes_cli.gateway_runtime',runtime), ('hermes_cli.gateway_client',client)]: sys.modules[name] = module
ns = {'__name__':'fixture'}
exec(compile(script,'<ssh-native-test>','exec'),ns)
f=ns['native_request']
def need(ok):
    if not ok: raise RuntimeError('Python edge assertion failed')
ctx.endpoint.profile_id='/home/ubuntu/.hermes/profiles/mira'
need(f({'operation':'discover','profile':'mira'})['ok'])
need(calls == [('profile','mira')]); calls.clear()
need(f({'operation':'discover','profile':'default'})['reason']=='profile_mismatch'); calls.clear()
ctx.endpoint.profile_id='/home/ubuntu/.hermes'
need(f({'operation':'ticket','profile':'default','purpose':'native-http','expected_instance':'one'})['ticket']=='fake-test-ticket')
need(calls[-1] == ('ticket',{'purpose':'native-http'})); calls.clear()
need(f({'operation':'ticket','profile':'default','purpose':'interactive','expected_instance':'old'})['reason']=='owner_changed')
need(not any(c[0]=='ticket' for c in calls)); calls.clear()
need(f({'operation':'discover','profile':'../outside'})['reason']=='invalid_profile')
need(calls==[])
need(f({'operation':'discover','profile':'default','subject':'other-user'})['reason']=='invalid_request')
need(calls==[])
ctx.state='absent'
need(f({'operation':'discover','profile':'default'})['reason']=='owner_not_ready')
ctx.state='ready';ctx.endpoint.api_origin='https://outside.example'
need(f({'operation':'discover','profile':'default'})['reason']=='invalid_owner')
need(not any(c[0]=='ticket' for c in calls))
print(json.dumps({'passed':8,'live_calls':0}))
`
  const result = spawnSync('python', ['-I', '-c', code], { input: JSON.stringify({ script: NATIVE_SSH_SCRIPT }), encoding: 'utf8', timeout: 10_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ passed: 8, live_calls: 0 })
})
