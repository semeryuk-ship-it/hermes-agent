import { beforeEach, expect, test, vi } from 'vitest'
const api = vi.hoisted(() => ({ discover: vi.fn(), mint: vi.fn(), close: vi.fn() }))
vi.mock('./ssh-native-owner', () => ({ createNativeSshOwnerClient: () => api }))
import { createLocalGatewayDials } from './local-gateway'
import { connectNativeSshOwner } from './ssh-native-connection'
const endpoint = { profile_id: '/home/ubuntu/.hermes', instance_id: 'one', api_origin: 'http://127.0.0.1:4567', runtime_protocol: 1 }
const ssh = () => ({ exec: vi.fn(), forward: vi.fn().mockResolvedValue(undefined), cancelForward: vi.fn().mockResolvedValue(undefined) })
beforeEach(() => {vi.resetAllMocks();api.discover.mockResolvedValue(endpoint);api.mint.mockResolvedValue('fake-ticket')})

test('a native viewer owns only its forward and closing never issues a remote stop', async () => {
  const transport = ssh()
  const c = await connectNativeSshOwner(transport, '/usr/bin/hermes', 'default', async () => 12345)
  expect(transport.forward).toHaveBeenCalledWith(12345,4567)
  expect(c.descriptor).not.toHaveProperty('gatewayEndpoint')
  expect(c.descriptor.token).toBeNull()
  expect(JSON.stringify(c.descriptor)).not.toContain('fake-ticket')
  await c.close();await c.close()
  expect(transport.cancelForward).toHaveBeenCalledTimes(1)
  expect(transport.exec).not.toHaveBeenCalled()
})

test('HTTP mints per request and refuses a different origin before granting access', async () => {
  const c = await connectNativeSshOwner(ssh(), '/usr/bin/hermes', 'default', async () => 12345)
  await c.httpHeaders(c.baseUrl+'/api/sessions','GET')
  await c.httpHeaders(c.baseUrl+'/api/sessions','GET')
  expect(api.mint).toHaveBeenCalledTimes(2)
  await expect(c.httpHeaders('http://127.0.0.1:9999/api/sessions','GET')).rejects.toThrow('origin')
  expect(api.mint).toHaveBeenCalledTimes(2)
})

test('the named profile is resolved remotely and its separate grant uses the same owner', async () => {
  const c = await connectNativeSshOwner(ssh(), '/usr/bin/hermes', 'default', async () => 12345)
  const mira = { ...endpoint, profile_id:'/home/ubuntu/.hermes/profiles/mira' }
  api.discover.mockResolvedValueOnce(mira)
  await c.httpHeaders(c.baseUrl+'/api/sessions?profile=mira','GET')
  expect(api.discover).toHaveBeenLastCalledWith('mira')
  expect(api.mint).toHaveBeenLastCalledWith('mira','native-http',mira)
})

test('a sibling on a different owner is refused without mint or fallback', async () => {
  const c = await connectNativeSshOwner(ssh(), '/usr/bin/hermes', 'default', async () => 12345)
  api.discover.mockResolvedValueOnce({ ...endpoint, instance_id:'other' })
  await expect(c.dial('mira','interactive',()=>null)).rejects.toThrow('different owner')
  expect(api.mint).not.toHaveBeenCalled()
})

test('owner replacement requires explicit reconnect and never starts a separate backend', async () => {
  const transport=ssh()
  const old=await connectNativeSshOwner(transport,'/usr/bin/hermes','default',async()=>12345)
  api.mint.mockRejectedValueOnce(new Error('Native SSH identity changed'))
  const prepare=vi.fn()
  await expect(old.dial('default','interactive',prepare)).rejects.toThrow('identity changed')
  expect(prepare).not.toHaveBeenCalled();expect(api.discover).toHaveBeenCalledTimes(1)
  expect(transport.exec).not.toHaveBeenCalled()
  await old.close()
  api.discover.mockResolvedValueOnce({...endpoint,instance_id:'replacement'})
  const next=await connectNativeSshOwner(ssh(),'/usr/bin/hermes','default',async()=>12346)
  await next.dial('default','interactive',prepare)
  expect(api.mint).toHaveBeenLastCalledWith('default','interactive',expect.objectContaining({instance_id:'replacement'}))
  expect(next.id).not.toBe(old.id)
  await next.close()
})

test('a close during ticket mint cannot publish a nonce to a retired viewer', async () => {
  const c = await connectNativeSshOwner(ssh(), '/usr/bin/hermes', 'default', async () => 12345)
  let finish: (value:string)=>void = () => {}
  api.mint.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const prepare = vi.fn();const pending = c.dial('default','interactive',prepare)
  await c.close();finish('retired-ticket')
  await expect(pending).rejects.toThrow('closed')
  expect(prepare).not.toHaveBeenCalled()
})

test('profile registry writes require an unimplemented capability rather than a broader ticket', async () => {
  const c = await connectNativeSshOwner(ssh(), '/usr/bin/hermes', 'default', async () => 12345)
  await expect(c.httpHeaders(c.baseUrl+'/api/profiles/mira','DELETE')).rejects.toThrow('not supported')
  expect(api.mint).not.toHaveBeenCalled()
})

test('concurrent and repeated close calls observe the same cancellation failure', async () => {
  const transport = ssh();transport.cancelForward.mockRejectedValue(new Error('cancel not confirmed'))
  const c = await connectNativeSshOwner(transport, '/usr/bin/hermes', 'default', async () => 12345)
  const a=c.close();const b=c.close()
  expect(a).toBe(b)
  await expect(a).rejects.toThrow('not confirmed')
  await expect(b).rejects.toThrow('not confirmed')
  await expect(c.close()).rejects.toThrow('not confirmed')
  expect(transport.cancelForward).toHaveBeenCalledTimes(1)
  await expect(c.dial('default','interactive',()=>null)).rejects.toThrow('closed')
})

// The registry stays in Electron main; tickets only cross its private prepare callback.
test('main auth rejects a retired viewer id without using local credentials', async () => {
  const {createNativeSshAuth}=await import('./ssh-native-connection')
  const localHeaders=vi.fn();const prepare=vi.fn();const preparePlugin=vi.fn()
  const auth=createNativeSshAuth(new Map(),{localHeaders,prepare,preparePlugin})
  expect(()=>auth.httpHeaders({nativeSshId:'retired'},'http://127.0.0.1:12345/api/health','GET')).toThrow('no longer attached')
  expect(localHeaders).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled()
})
test('native HTTP and plugin sockets use the same registered viewer and retain window ownership', async () => {
  const {createNativeSshAuth}=await import('./ssh-native-connection')
  const c=await connectNativeSshOwner(ssh(),'/usr/bin/hermes','default',async()=>12345)
  const prepare=vi.fn().mockReturnValue('ws://127.0.0.1/api/ws?native_dial=private-nonce');const preparePlugin=vi.fn().mockReturnValue('plugin-nonce')
  const auth=createNativeSshAuth(new Map([[c.id,c]]),{localHeaders:vi.fn(),prepare,preparePlugin})
  await expect(auth.dial(c.descriptor,'default',42)).resolves.toBe('ws://127.0.0.1/api/ws?native_dial=private-nonce&desktop_remote=ssh')
  expect(prepare).toHaveBeenCalledWith(c.baseUrl,'fake-ticket',42)
  await expect(auth.dial(c.descriptor,'default',43,'/api/plugins/board/events')).resolves.toBe('plugin-nonce')
  expect(preparePlugin).toHaveBeenCalledWith(c.baseUrl,'/api/plugins/board/events','fake-ticket',43)
})
test('existing local descriptor authentication remains with its native local provider', async () => {
  const {createNativeSshAuth}=await import('./ssh-native-connection')
  const localHeaders=vi.fn().mockResolvedValue({'local':'existing'})
  const auth=createNativeSshAuth(new Map(),{localHeaders,prepare:vi.fn(),preparePlugin:vi.fn()})
  const descriptor={gatewayEndpoint:{profile_id:'local'}}
  await expect(auth.httpHeaders(descriptor,'http://127.0.0.1:12345/api/health','GET')).resolves.toEqual({local:'existing'})
  expect(localHeaders).toHaveBeenCalledWith(descriptor,'http://127.0.0.1:12345/api/health','GET',undefined)
})

test('native SSH auth uses stock window-bound one-use WS and plugin credentials', async () => {
  const {createNativeSshAuth}=await import('./ssh-native-connection')
  const c=await connectNativeSshOwner(ssh(),'/usr/bin/hermes','default',async()=>12345)
  const dials=createLocalGatewayDials()
  const auth=createNativeSshAuth(new Map([[c.id,c]]),{
    localHeaders:vi.fn(),prepare:dials.prepare,preparePlugin:dials.preparePlugin
  })
  const raw=await auth.dial(c.descriptor,'default',42)
  const url=new URL(raw);url.searchParams.delete('ticket')
  const request={url:url.toString(),webContentsId:43,resourceType:'webSocket',requestHeaders:{Origin:'renderer'}}
  expect(dials.headers(request)).toBeNull()
  expect(dials.headers({...request,webContentsId:42})).not.toHaveProperty('Origin')
  expect(dials.headers({...request,webContentsId:42})).toBeNull()
  const plugin=await auth.dial(c.descriptor,'default',42,'/api/plugins/board/events')
  const details={...request,url:plugin,webContentsId:42}
  expect(dials.headers({...details,url:plugin.replace(':12345',':12346')})).toBeNull()
  expect(dials.headers({...details,webContentsId:43})).toBeNull()
  expect(dials.headers(details)).toEqual({'X-Hermes-Gateway-Ticket':'fake-ticket'})
  expect(dials.headers(details)).toBeNull()
  await c.close()
})
