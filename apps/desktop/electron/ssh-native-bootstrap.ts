import crypto from 'node:crypto'

import { connectNativeSshOwner, type NativeSshConnection } from './ssh-native-connection'

/** Only records created with SshConnection(mux:false) may use this cleanup. */
export async function closeOwnedNativeSshViewer(record, registry) {
  if (record.ownedTunnels !== true) {throw new Error('Native SSH transport ownership is not proven')}
  let cancellationFailed = false
  try {await registry.get(record.id)?.close()} catch {cancellationFailed = true}
  // No-mux close awaits the actual owned tunnel children; a failed stop throws and
  // leaves their handles available. It never stops the remote gateway process.
  try {await record.ssh.close()} catch {throw new Error('Native SSH owned tunnel cleanup is not confirmed')}
  registry.delete(record.id)
  return { cancellationFailed, transportClosed: true }
}

export async function recoverPendingNativeSshCleanup(scope, pending, registry) {
  for (const [key, record] of pending) {
    if (record.scope !== scope) {continue}
    await closeOwnedNativeSshViewer(record, registry)
    pending.delete(key)
  }
}

export async function bootstrapNativeSshViewer({ ssh, sshConfig, profile, source, metadata, fingerprint, lease, created, removeForceCleanup }, deps) {
  const { sshScopeKey, sshConnections, nativeSshConnections, detectRemotePlatform, resolveRemoteSshDashboardProfile, locateHermes, expandRemotePath, pickLocalPort, fenceManagedSshBootstrapPublication, assertCanDial, pendingNativeSshCleanup } = deps
  const scope = sshScopeKey(profile)
  if (!created) {throw new Error('Native SSH viewer requires a separately owned transport')}
  let native: NativeSshConnection | undefined
  let published = false
  try {
    await ssh.open({ signal: lease.signal })
    lease.assertCurrent()
    const previous = sshConnections.get(scope)
    const retired = [...(previous?.retiredNativeSshConnections || []), ...(previous?.nativeSshId ? [{ id: previous.nativeSshId, ssh: previous.ssh, ownedTunnels: previous.nativeOwnedTunnels }] : [])]
    if (retired.some(record => record.ownedTunnels !== true)) {throw new Error('Previous native transport ownership is unknown')}
    const platform = await detectRemotePlatform(ssh, sshConfig.remoteHermesPath || '')
    if (platform.os !== 'Linux') {throw new Error('Native SSH viewer currently requires a Linux server')}
    const remoteProfile = resolveRemoteSshDashboardProfile(sshConfig.remoteProfile, profile) || 'default'
    const located = await locateHermes(ssh, sshConfig.remoteHermesPath || '')
    const launcher = (await ssh.exec("printf '%s' " + expandRemotePath(located))).trim()
    native = await connectNativeSshOwner(ssh, launcher, remoteProfile, async () => Number(await pickLocalPort()))
    const attached = native
    const removeNativeCleanup = lease.onForceCleanup(() => attached.close())
    await fenceManagedSshBootstrapPublication({
      assertCanPublish: () => {
        lease.assertCurrent()
        if (metadata.registryConnectionId) {assertCanDial(metadata.registryConnectionId, metadata.managedUpdateCorrelation || '')}
      },
      publish: () => {
        nativeSshConnections.set(attached.id, attached)
        sshConnections.set(scope, { ssh, fingerprint, nativeSshId: attached.id, host: sshConfig.host,
          localPort: attached.localPort, remotePort: attached.remotePort, remotePlatform: platform.os, retiredNativeSshConnections: retired, nativeOwnedTunnels: true,
          remoteProfile, registryConnectionId: metadata.registryConnectionId || '', primaryRegistryScope: metadata.primaryRegistryScope === true })
        published = true
        removeNativeCleanup()
        removeForceCleanup()
      },
      rollback: async () => {await attached.close()}
    })
    // Only retire the previous forward after the replacement passed every fence.
    for (const record of retired) {await closeOwnedNativeSshViewer(record, nativeSshConnections)}
    const current = sshConnections.get(scope)
    if (current?.nativeSshId === attached.id) {current.retiredNativeSshConnections = []}
    return { ...attached.descriptor, source, remoteHost: sshConfig.host,
      ssh: { gatewayMode: 'native', remoteProfile, host: sshConfig.host, user: sshConfig.user, port: sshConfig.port,
        keyPath: sshConfig.keyPath, remoteHermesPath: sshConfig.remoteHermesPath, effectiveConfigFingerprint: sshConfig.effectiveConfigFingerprint } }
  } catch {
    if (published) {
      throw new Error('Native SSH replacement attached, but previous forward cleanup is incomplete; no owner was stopped')
    }
    let cleanupFailed = false
    const id = native?.id || crypto.randomUUID()
    const record = {id,ssh,scope,ownedTunnels:true}
    // A failed pre-publication cleanup must remain discoverable even when no
    // public descriptor was ever created. Keep the actual owned SSH handle.
    if (native) {nativeSshConnections.set(id,native)}
    pendingNativeSshCleanup.set(id,record)
    try {
      await closeOwnedNativeSshViewer(record,nativeSshConnections)
      pendingNativeSshCleanup.delete(id)
    } catch {cleanupFailed = true}
    throw new Error(cleanupFailed
      ? 'Native SSH attach failed and transport cleanup is incomplete; no independent backend was started'
      : 'Could not attach the existing native SSH gateway; no independent backend was started')
  }
}
