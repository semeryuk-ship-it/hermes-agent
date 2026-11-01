import { expect, test } from 'vitest'

import { readForLocalWindow, windowBackendIsLocal } from './window-connection-route'

const registry: any = { version: 2, primary: 'local', connections: [
  { id: 'local', kind: 'local' }, { id: 'uz', kind: 'ssh', ssh: { host: 'server', gatewayMode: 'native' } },
  { id: 'url', kind: 'remote', url: 'https://example.test' }
] }

test('OS window access follows each exact window route and denies stale/remote sources', () => {
  const input = { config: { mode: 'local' }, registry }
  for (const id of ['uz', 'url', 'missing']) {
    expect(windowBackendIsLocal({ connectionId: id, registryScoped: true, profile: 'default' }, input)).toBe(false)
  }
  expect(windowBackendIsLocal({ connectionId: 'local', registryScoped: true, profile: 'default' }, input)).toBe(true)
  expect(windowBackendIsLocal(null, input)).toBe(true)
})

test('legacy global SSH, profile overrides and environment routes cannot read Windows', () => {
  expect(windowBackendIsLocal(null, { registry, config: { mode: 'ssh', ssh: { host: 'server' } } })).toBe(false)
  expect(windowBackendIsLocal(null, { registry, config: { mode: 'local' }, env: { url: 'https://example.test', token: 'fixture' } })).toBe(false)
  expect(windowBackendIsLocal({ connectionId: null, registryScoped: false, profile: 'mira' }, {
    registry, config: { mode: 'local', profiles: { mira: { mode: 'ssh', host: 'server' } } }
  })).toBe(false)
})


test('missing primary and malformed registry deny OS access', () => {
  for (const value of [{ ...registry, primary: 'missing' }, null, {}]) {
    expect(windowBackendIsLocal(null, { config: { mode: 'local' }, registry: value as any })).toBe(false)
  }
})

test('explicit local registry route stays on this device despite remote global config', () => {
  expect(windowBackendIsLocal({ connectionId: 'local', registryScoped: true, profile: 'mira' }, {
    registry, config: { mode: 'ssh', ssh: { host: 'server' }, profiles: { mira: { mode: 'ssh', host: 'other' } } }
  })).toBe(true)
})

test('async metadata is discarded after route replacement, including a switch back', async () => {
  let route: any = { connectionId: 'local', registryScoped: true }
  let finish!: (value: string) => void
  const result = readForLocalWindow(() => route, () => ({ config: { mode: 'local' }, registry }),
    () => new Promise<string>(resolve => {finish = resolve}), () => 0)
  route = { connectionId: 'uz', registryScoped: true }
  route = { connectionId: 'local', registryScoped: true }
  finish('private metadata')
  expect(await result).toBe(null)
})

test('remote route refuses before OS enumeration', async () => {
  let calls = 0
  expect(await readForLocalWindow(() => ({ connectionId: 'uz', registryScoped: true, profile: 'default' }),
    () => ({ config: { mode: 'local' }, registry }), async () => {calls++; return 'private'}, () => 0)).toBe(null)
  expect(calls).toBe(0)
})

test('primary local to remote to local transition discards pending metadata', async () => {
  let generation = 0
  let finish!: (value: string) => void
  const result = readForLocalWindow(() => null, () => ({ config: { mode: 'local' }, registry }),
    () => new Promise<string>(resolve => {finish = resolve}), () => generation)
  generation += 2
  finish('private metadata')
  expect(await result).toBe(null)
})

test('cache invalidation during fresh config read discards metadata', async () => {
  let generation = 0
  let reads = 0
  const result = await readForLocalWindow(() => null, () => {
    if (++reads === 2) {generation++}
    return { config: { mode: 'local' }, registry }
  }, async () => 'private metadata', () => generation)
  expect(result).toBe(null)
})
