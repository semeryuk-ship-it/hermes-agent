import { beforeEach, expect, test, vi } from 'vitest'
const connect=vi.hoisted(()=>vi.fn())
vi.mock('./ssh-native-connection',()=>({connectNativeSshOwner:connect}))
import { bootstrapNativeSshViewer, closeOwnedNativeSshViewer, recoverPendingNativeSshCleanup } from './ssh-native-bootstrap'
function fixture() {
 const old={id:'old',close:vi.fn().mockResolvedValue(undefined)}
 const next={id:'new',close:vi.fn().mockResolvedValue(undefined),localPort:12345,remotePort:4567,descriptor:{baseUrl:'http://127.0.0.1:12345',nativeSshId:'new'}}
 const ssh={open:vi.fn().mockResolvedValue(undefined),exec:vi.fn().mockResolvedValue('/usr/bin/hermes'),close:vi.fn().mockResolvedValue(undefined)}
 const oldSsh={close:vi.fn().mockResolvedValue(undefined)}
 const states=new Map<string,any>([['default',{ssh:oldSsh,nativeSshId:'old',nativeOwnedTunnels:true}]])
 const natives=new Map([['old',old]])
 const lease={assertCurrent:vi.fn(),onForceCleanup:vi.fn().mockReturnValue(vi.fn())}
 const pending=new Map<string,any>()
 const deps={pendingNativeSshCleanup:pending,sshScopeKey:()=> 'default',sshConnections:states,nativeSshConnections:natives,
  detectRemotePlatform:vi.fn().mockResolvedValue({os:'Linux'}),resolveRemoteSshDashboardProfile:()=> 'default',
  locateHermes:vi.fn().mockResolvedValue('/usr/bin/hermes'),expandRemotePath:(s)=>s,pickLocalPort:async()=>12345,
  assertCanDial:vi.fn(),fenceManagedSshBootstrapPublication:async({assertCanPublish,publish,rollback})=>{try{assertCanPublish();publish()}catch(e){await rollback(e);throw e}}}
 const ctx={ssh,sshConfig:{host:'box'},profile:'default',source:'settings',metadata:{},fingerprint:'fp',lease,created:true,removeForceCleanup:vi.fn()}
 connect.mockResolvedValue(next)
 return {old,next,ssh,oldSsh,pending,states,natives,lease,deps,ctx}
}
beforeEach(()=>vi.resetAllMocks())
test('a failed replacement preserves the existing working forward and state',async()=>{
 const f=fixture();connect.mockRejectedValueOnce(new Error('discovery failed'))
 await expect(bootstrapNativeSshViewer(f.ctx,f.deps)).rejects.toThrow('no independent backend')
 expect(f.states.get('default').nativeSshId).toBe('old')
 expect(f.natives.get('old')).toBe(f.old)
 expect(f.old.close).not.toHaveBeenCalled();expect(f.oldSsh.close).not.toHaveBeenCalled();expect(f.ssh.close).toHaveBeenCalledTimes(1)
})
test('a stale publication fence preserves the previous viewer and cleans only the candidate',async()=>{
 const f=fixture();f.lease.assertCurrent.mockImplementationOnce(()=>undefined).mockImplementation(()=>{throw new Error('stale')})
 await expect(bootstrapNativeSshViewer(f.ctx,f.deps)).rejects.toThrow('no independent backend')
 expect(f.states.get('default').nativeSshId).toBe('old');expect(f.old.close).not.toHaveBeenCalled()
 expect(f.next.close).toHaveBeenCalled();expect(f.natives.has('new')).toBe(false)
})
test('successful publication precedes retirement of the previous viewer',async()=>{
 const f=fixture()
 f.old.close.mockImplementation(async()=>{expect(f.states.get('default').nativeSshId).toBe('new')})
 const result=await bootstrapNativeSshViewer(f.ctx,f.deps)
 expect(result.nativeSshId).toBe('new');expect(f.old.close).toHaveBeenCalledTimes(1)
 expect(f.natives.has('old')).toBe(false);expect(f.states.get('default').retiredNativeSshConnections).toEqual([])
 expect(f.ssh.close).not.toHaveBeenCalled()
})
test('an unconfirmed retired forward remains observable instead of losing its cleanup handle',async()=>{
 const f=fixture();f.old.close.mockRejectedValueOnce(new Error('cancel unknown'));f.oldSsh.close.mockRejectedValueOnce(new Error('owned child still live'))
 await expect(bootstrapNativeSshViewer(f.ctx,f.deps)).rejects.toThrow('cleanup is incomplete')
 expect(f.states.get('default').nativeSshId).toBe('new')
 expect(f.states.get('default').retiredNativeSshConnections[0]).toMatchObject({id:'old',ssh:f.oldSsh,ownedTunnels:true})
 expect(f.natives.get('old')).toBe(f.old);expect(f.next.close).not.toHaveBeenCalled()
})

test('failed cancellation recovers only through the same owned no-mux SSH transport',async()=>{
 const f=fixture();f.old.close.mockRejectedValueOnce(new Error('cancel unknown'))
 await expect(closeOwnedNativeSshViewer({id:'old',ssh:f.oldSsh,ownedTunnels:true},f.natives)).resolves.toEqual({cancellationFailed:true,transportClosed:true})
 expect(f.oldSsh.close).toHaveBeenCalledTimes(1);expect(f.ssh.close).not.toHaveBeenCalled();expect(f.natives.has('old')).toBe(false)
})
test('failed owned SSH close preserves the handle for a later confirmed cleanup',async()=>{
 const f=fixture();f.oldSsh.close.mockRejectedValueOnce(new Error('still live'))
 const record={id:'old',ssh:f.oldSsh,ownedTunnels:true}
 await expect(closeOwnedNativeSshViewer(record,f.natives)).rejects.toThrow('not confirmed')
 expect(f.natives.get('old')).toBe(f.old)
 await expect(closeOwnedNativeSshViewer(record,f.natives)).resolves.toMatchObject({transportClosed:true})
 expect(f.natives.has('old')).toBe(false)
})

test('prepublication cleanup failure retains the new SSH handle for scoped recovery',async()=>{
 const f=fixture();connect.mockRejectedValueOnce(new Error('discovery failed'));f.ssh.close.mockRejectedValueOnce(new Error('owned tunnel still live'))
 await expect(bootstrapNativeSshViewer(f.ctx,f.deps)).rejects.toThrow('cleanup is incomplete')
 expect(f.pending.size).toBe(1)
 const record=[...f.pending.values()][0];expect(record.ssh).toBe(f.ssh)
 expect(f.states.get('default').nativeSshId).toBe('old');expect(f.oldSsh.close).not.toHaveBeenCalled()
 await recoverPendingNativeSshCleanup('default',f.pending,f.natives)
 expect(f.pending.size).toBe(0);expect(f.ssh.close).toHaveBeenCalledTimes(2)
})

test('open failure is cleaned before discovery and preserves the existing viewer',async()=>{
 const f=fixture();f.ssh.open.mockRejectedValueOnce(new Error('connect failed'))
 await expect(bootstrapNativeSshViewer(f.ctx,f.deps)).rejects.toThrow('attach the existing')
 expect(f.ssh.close).toHaveBeenCalledTimes(1);expect(connect).not.toHaveBeenCalled()
 expect(f.deps.detectRemotePlatform).not.toHaveBeenCalled()
 expect(f.states.get('default').nativeSshId).toBe('old');expect(f.oldSsh.close).not.toHaveBeenCalled()
 expect(f.pending.size).toBe(0)
})

test('open failure with unknown cleanup retains its actual transport for recovery',async()=>{
 const f=fixture();f.ssh.open.mockRejectedValueOnce(new Error('open interrupted'))
 f.ssh.close.mockRejectedValueOnce(new Error('child unknown'))
 await expect(bootstrapNativeSshViewer(f.ctx,f.deps)).rejects.toThrow('cleanup is incomplete')
 expect([...f.pending.values()][0].ssh).toBe(f.ssh);expect(connect).not.toHaveBeenCalled()
 await recoverPendingNativeSshCleanup('default',f.pending,f.natives)
 expect(f.pending.size).toBe(0);expect(f.ssh.close).toHaveBeenCalledTimes(2)
})
