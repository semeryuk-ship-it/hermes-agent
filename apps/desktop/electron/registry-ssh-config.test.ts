import { expect, test, vi } from 'vitest'

import { dialRegistrySshBackend, type RegistryConnection, registrySshConfig } from './connection-registry'

const source: RegistryConnection = { id:'uz', kind:'ssh', label:'UZ', host:'hermes-uz', gatewayMode:'native' }

test('root and sibling profile registry dials retain the native owner protocol', () => {
  expect(registrySshConfig(source,'default')).toMatchObject({ host:'hermes-uz',gatewayMode:'native' })
  expect(registrySshConfig(source,'mira')).toMatchObject({ host:'hermes-uz',gatewayMode:'native',remoteProfile:'mira' })
  expect(registrySshConfig({...source,remoteProfile:'mira'},'default')?.remoteProfile).toBe('mira')
})

test('legacy registry routes retain their prior transport selection', () => {
  const {gatewayMode,...legacy}=source
  expect(registrySshConfig(legacy,'mira')).toMatchObject({ host:'hermes-uz',remoteProfile:'mira' })
  expect(registrySshConfig(legacy,'mira')).not.toHaveProperty('gatewayMode')
})

test('invalid owner protocol is refused rather than silently selecting a dashboard', () => {
  expect(()=>registrySshConfig({...source,gatewayMode:'unknown' as never},'mira')).toThrow('Unsupported SSH gateway mode')
})

test('the dial consumer refuses a native source with a resolved legacy config before bootstrap', () => {
  const bootstrap=vi.fn()
  const legacy=registrySshConfig({...source,gatewayMode:undefined},'mira')
  expect(()=>dialRegistrySshBackend(source,legacy,bootstrap)).toThrow('lost its owner protocol')
  expect(bootstrap).not.toHaveBeenCalled()
})

test('the actual dial boundary passes native Mira routing unchanged to bootstrap', async () => {
  const bootstrap=vi.fn().mockResolvedValue({nativeSshId:'viewer'})
  const config=registrySshConfig(source,'mira')
  await expect(dialRegistrySshBackend(source,config,bootstrap)).resolves.toEqual({nativeSshId:'viewer'})
  expect(bootstrap).toHaveBeenCalledExactlyOnceWith(config)
  expect(bootstrap.mock.calls[0][0]).toMatchObject({gatewayMode:'native',remoteProfile:'mira'})
})

test('the legacy consumer still uses its resolved transport and a missing host never boots', () => {
  const legacy={...source,gatewayMode:undefined}
  const config=registrySshConfig(legacy,'mira'),bootstrap=vi.fn().mockReturnValue('legacy')
  expect(dialRegistrySshBackend(legacy,config,bootstrap)).toBe('legacy')
  expect(bootstrap).toHaveBeenCalledExactlyOnceWith(config)
  bootstrap.mockClear()
  expect(()=>dialRegistrySshBackend(legacy,null,bootstrap)).toThrow('no host configured')
  expect(bootstrap).not.toHaveBeenCalled()
})
