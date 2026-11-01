import { waitForTeardown } from './local-backend-lifecycle'

/** Retain transports removed from routing until their remote kill has settled. */
export function createSshTeardownTracker() {
  const pending = new Map<Promise<void>, { close: () => Promise<unknown> }>()

  return {
    hasPending: () => pending.size > 0,
    track(ssh: { close: () => Promise<unknown> }, teardown: () => Promise<void>): Promise<void> {
      const promise = Promise.resolve().then(teardown)
      pending.set(promise, ssh)
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise)
      )

      return promise
    },
    async finish(
      bootstraps: Promise<unknown>[],
      forceCleanup: () => Promise<unknown>,
      graceMs = 6_000,
      forceMs = 1_000
    ) {
      await waitForTeardown([...pending.keys(), ...bootstraps], graceMs)
      // Only abandon the transport after the existing remote-kill grace period.
      // Closing SSH unblocks a wedged exec; both close and bootstrap force cleanup
      // are bounded too, not an unbounded await after a nominal timeout.
      await waitForTeardown(
        [
          Promise.resolve().then(forceCleanup),
          ...[...new Set(pending.values())].map(ssh => Promise.resolve().then(() => ssh.close()))
        ],
        forceMs
      )
    }
  }
}

export async function teardownDesktopSshConnection(profile, deps) {
  const { sshScopeKey, stopKeepalive, sshConnections, pendingNativeSshCleanup, nativeSshConnections,
    recoverPendingNativeSshCleanup, disposeTerminals, trackTeardown, closeOwnedNativeSshViewer,
    teardownSshState, sshOwnershipKey, rememberLog, disconnectLegacy } = deps
  const scope = sshScopeKey(profile)
  stopKeepalive(scope)
  const state = sshConnections.get(scope)
  await recoverPendingNativeSshCleanup(scope, pendingNativeSshCleanup, nativeSshConnections)
  if (sshConnections.get(scope) !== state) {return}

  if (!state) {
    return
  }

  disposeTerminals(scope)

  if (state.nativeSshId) {
    if (!state.nativeCleanupPromise) {
      const records = [{id:state.nativeSshId,ssh:state.ssh,ownedTunnels:state.nativeOwnedTunnels}, ...(state.retiredNativeSshConnections || [])]
      state.nativeCleanupPromise = trackTeardown(state.ssh, async () => {
        for (const record of records) {await closeOwnedNativeSshViewer(record, nativeSshConnections)}
        if (sshConnections.get(scope) === state) {sshConnections.delete(scope)}
      }).catch(error => {state.nativeCleanupPromise = null; throw error})
    }
    await state.nativeCleanupPromise
    return
  }
  sshConnections.delete(scope)

  // Kill the owned remote serve --isolated *before* closing the SSH
  // transport. Spawn detaches with setsid/nohup, so closing the tunnel
  // alone leaves the backend at pid 1 holding state.db (#91668).
  // Windows remotes use a different lifecycle (connectWindowsRemote) and
  // are left to a follow-up; POSIX is the leak that OOM'd gateways.
  await trackTeardown(state.ssh, (): Promise<void> =>
    teardownSshState(
      {
        ...state,
        ownershipId: state.ownershipId || sshOwnershipKey(profile)
      },
      {
        cleanupRemote:
          state.remotePlatform === 'Windows'
            ? async () => {
                // connectWindowsRemote does not share POSIX lock/kill. Stay
                // silent on the kill path, but leave a log so quit is not a
                // mysterious no-op on Windows remotes.
                rememberLog('[ssh] skip remote serve teardown on Windows remotes; POSIX disconnect does not apply')
              }
            : disconnectLegacy
      }
    )
  )
}
