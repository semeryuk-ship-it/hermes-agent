import { EventEmitter } from 'node:events'

import { expect, test, vi } from 'vitest'

import { runSsh } from './ssh-connection'
function child() {
  return Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:vi.fn()})
}
test('native SSH replies are bounded during collection and buffered content never escapes', async () => {
  const p=child();const pending=runSsh([],{spawnFn:()=>p,timeoutMs:1000,maxOutputBytes:8})
  p.stdout.emit('data',Buffer.from('PRIVATE'))
  p.stderr.emit('data',Buffer.from('SECRET'))
  await expect(pending).rejects.toThrow('output limit')
  expect(p.kill).toHaveBeenCalledWith('SIGKILL')
})
test('an in-budget response preserves data and normal command completion', async () => {
  const p=child();const pending=runSsh([],{spawnFn:()=>p,timeoutMs:1000,maxOutputBytes:8})
  p.stdout.emit('data',Buffer.from('ready'));p.emit('close',0,null)
  await expect(pending).resolves.toMatchObject({stdout:'ready',stderr:'',code:0})
  expect(p.kill).not.toHaveBeenCalled()
})
