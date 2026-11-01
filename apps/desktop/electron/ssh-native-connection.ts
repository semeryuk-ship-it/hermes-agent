import crypto from 'node:crypto'

import { nativeGrantProfile, nativeGrantPurpose } from './local-gateway'
import { createNativeSshOwnerClient, type NativeSshExec, type NativeSshOwner, type NativeSshPurpose } from './ssh-native-owner'

export interface NativeSshTransport extends NativeSshExec {
  forward(localPort: number, remotePort: number, remoteHost?: string): Promise<unknown>
  cancelForward(localPort: number, remotePort: number): Promise<unknown>
}

/** A viewer connection owns a forward, never the remote gateway process. */
export async function connectNativeSshOwner(
  ssh: NativeSshTransport, launcher: string, profile: string,
  pickPort: () => Promise<number>
) {
  const baseProfile = profile || 'default'
  const client = createNativeSshOwnerClient(ssh, launcher)
  const launchOwner = await client.discover(baseProfile)
  const target = new URL(launchOwner.api_origin)
  if (target.hostname !== '127.0.0.1') {throw new Error('Native SSH currently requires an IPv4 loopback listener')}
  const localPort = await pickPort()
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {throw new Error('Invalid native SSH forward port')}
  const remotePort = Number(target.port)
  await ssh.forward(localPort, remotePort)
  const baseUrl = `http://127.0.0.1:${localPort}`
  const id = crypto.randomUUID()
  const profiles = new Map<string, NativeSshOwner>([[baseProfile, launchOwner]])
  let closed = false
  let closePromise: Promise<void> | undefined
  const checkOpen = () => {if (closed) {throw new Error('Native SSH viewer is closed')}}
  const routedProfile = (requested: string) => !requested || requested === 'current' ? baseProfile : requested

  async function mint(requested: string, purpose: NativeSshPurpose): Promise<string> {
    checkOpen()
    const name = routedProfile(requested)
    let endpoint = profiles.get(name)
    if (!endpoint) {
      endpoint = await client.discover(name)
      if (endpoint.instance_id !== launchOwner.instance_id || endpoint.api_origin !== launchOwner.api_origin) {
        throw new Error('Native SSH profile belongs to a different owner; reconnect explicitly')
      }
      profiles.set(name, endpoint)
    }
    const ticket = await client.mint(name, purpose, endpoint)
    checkOpen()
    return ticket
  }

  return {
    id, localPort, remotePort, baseUrl,
    descriptor: { baseUrl, mode: 'remote' as const, source: 'ssh', authMode: 'native' as const,
      nativeSshId: id, token: null, remoteKind: 'ssh' as const,
      wsUrl: `${baseUrl.replace(/^http/, 'ws')}/api/ws?native_dial=unminted` },
    async httpHeaders(url: string, method: string, body?: unknown): Promise<Record<string, string>> {
      checkOpen()
      if (new URL(url).origin !== baseUrl) {throw new Error('Native SSH HTTP origin mismatch')}
      const purpose = nativeGrantPurpose(url, method)
      if (purpose !== 'native-http') {throw new Error('Profile registry changes are not supported by this native SSH viewer yet')}
      return { 'X-Hermes-Gateway-Ticket': await mint(nativeGrantProfile(url, body, method), purpose) }
    },
    async dial<T>(requested: string, purpose: NativeSshPurpose, prepare: (origin: string, ticket: string) => T): Promise<T> {
      const ticket = await mint(requested, purpose)
      checkOpen()
      return prepare(baseUrl, ticket)
    },
    close(): Promise<void> {
      // Share both success and failure: a second caller must not mistake an unknown
      // cancellation for a successfully closed listener. The owner closes SSH too.
      if (closePromise) {return closePromise}
      closed = true
      profiles.clear()
      closePromise = Promise.resolve().then(async () => {
        try { await client.close() } finally { await ssh.cancelForward(localPort, remotePort) }
      })
      return closePromise
    }
  }
}
export type NativeSshConnection = Awaited<ReturnType<typeof connectNativeSshOwner>>

/** Main-only capabilities; public descriptors carry only the opaque viewer id. */
export function createNativeSshAuth(registry: Map<string,NativeSshConnection>, deps: {
  localHeaders: (descriptor:unknown,url:string,method:string,body?:unknown)=>Promise<Record<string,string>>
  prepare: (origin:string,ticket:string,windowId:number)=>string
  preparePlugin: (origin:string,path:string,ticket:string,windowId:number)=>string
}) {
  const requireViewer = descriptor => {
    const value = registry.get(descriptor.nativeSshId)
    if (!value) {throw new Error('Native SSH viewer is no longer attached; reconnect explicitly')}
    return value
  }
  return {
    httpHeaders(descriptor,url:string,method:string,body?:unknown) {
      return descriptor.nativeSshId ? requireViewer(descriptor).httpHeaders(url,method,body) : deps.localHeaders(descriptor,url,method,body)
    },
    dial(descriptor,profile,windowId:number,pluginPath?:string) {
      return requireViewer(descriptor).dial(String(profile||''),pluginPath?'native-http':'interactive',
        (origin,ticket)=>pluginPath ? deps.preparePlugin(origin,pluginPath,ticket,windowId) : deps.prepare(origin,ticket,windowId))
    }
  }
}
