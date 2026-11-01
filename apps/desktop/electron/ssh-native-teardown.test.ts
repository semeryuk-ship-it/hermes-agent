import {expect,test,vi} from 'vitest'

import {teardownDesktopSshConnection} from './ssh-teardown'
function fixture(){
 const state={nativeSshId:'n',ssh:{},nativeOwnedTunnels:true,nativeCleanupPromise:null}
 const states=new Map([['default',state]])
 const deps={sshScopeKey:p=>p,stopKeepalive:vi.fn(),sshConnections:states,pendingNativeSshCleanup:new Map(),nativeSshConnections:new Map(),
  recoverPendingNativeSshCleanup:vi.fn().mockResolvedValue(undefined),disposeTerminals:vi.fn(),trackTeardown:(_s,fn)=>Promise.resolve().then(fn),
  closeOwnedNativeSshViewer:vi.fn().mockResolvedValue(undefined),teardownSshState:vi.fn().mockResolvedValue(undefined),sshOwnershipKey:()=> 'owned',rememberLog:vi.fn(),disconnectLegacy:vi.fn()}
 return{state,states,deps}
}
test('native cleanup failure keeps its scope handle and a later success retires it',async()=>{
 const f=fixture();f.deps.closeOwnedNativeSshViewer.mockRejectedValueOnce(new Error('not confirmed'))
 await expect(teardownDesktopSshConnection('default',f.deps)).rejects.toThrow('not confirmed')
 expect(f.states.get('default')).toBe(f.state);expect(f.state.nativeCleanupPromise).toBeNull()
 await teardownDesktopSshConnection('default',f.deps)
 expect(f.states.has('default')).toBe(false);expect(f.deps.teardownSshState).not.toHaveBeenCalled()
})
test('pending pre-publication resources are recovered even without a public scope',async()=>{
 const f=fixture();f.states.clear();await teardownDesktopSshConnection('default',f.deps)
 expect(f.deps.recoverPendingNativeSshCleanup).toHaveBeenCalledWith('default',f.deps.pendingNativeSshCleanup,f.deps.nativeSshConnections)
})
test('cleanup of a retired state cannot delete a replacement published during the await',async()=>{
 const f=fixture();const replacement={...f.state,nativeSshId:'replacement'}
 f.deps.closeOwnedNativeSshViewer.mockImplementationOnce(async()=>{f.states.set('default',replacement)})
 await teardownDesktopSshConnection('default',f.deps)
 expect(f.states.get('default')).toBe(replacement)
})

test('a legacy teardown cannot remove a replacement published while cleanup recovery awaited',async()=>{
 const f=fixture();const old={ssh:{},remotePlatform:'Linux'};const replacement={ssh:{},remotePlatform:'Linux'}
 f.states.set('default',old as any)
 f.deps.recoverPendingNativeSshCleanup.mockImplementationOnce(async()=>{f.states.set('default',replacement as any)})
 await teardownDesktopSshConnection('default',f.deps)
 expect(f.states.get('default')).toBe(replacement)
 expect(f.deps.teardownSshState).not.toHaveBeenCalled();expect(f.deps.closeOwnedNativeSshViewer).not.toHaveBeenCalled()
})
