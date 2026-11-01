import { expect, test, vi } from 'vitest'

import { CANONICAL_GATEWAY_PROTOCOL, CanonicalDesktopProtocol } from './canonical-protocol'

const snapshot = () => ({ session_id: 'existing', revision: 7, execution_generation: 3,
  info: { desktop_protocol: CANONICAL_GATEWAY_PROTOCOL, execution_generation: 3 } })

test('messaging resume reads model info for the same profile and preserves snapshot fences', async () => {
  const request = vi.fn().mockResolvedValue({ model: 'gpt-6.1-sol', reasoning_effort: 'low', execution_generation: 99 })
  const result = await new CanonicalDesktopProtocol().settle('session.resume', { profile: 'mira' }, snapshot(), request)
  expect(request.mock.calls).toEqual([['session.info', { session_id: 'existing', profile: 'mira' }]])
  expect(result.info).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'low', execution_generation: 3 })
  expect(result.revision).toBe(7)
})

test('a complete model snapshot needs no additional request', async () => {
  const request = vi.fn()
  const value = { ...snapshot(), info: { ...snapshot().info, model: 'claude-opus-5-5' } }
  expect(await new CanonicalDesktopProtocol().settle('session.resume', {}, value, request)).toBe(value)
  expect(request).not.toHaveBeenCalled()
})

test('refusal is surfaced without retry, model substitution or another profile', async () => {
  const request = vi.fn().mockRejectedValue(new Error('permission_denied'))
  await expect(new CanonicalDesktopProtocol().settle('session.resume', {}, snapshot(), request)).rejects.toThrow('permission_denied')
  expect(request.mock.calls).toEqual([['session.info', { session_id: 'existing' }]])
})

test.each([null, [], {}, { model: null }, { model: 123 }, { model: '   ' }])('malformed info refuses without treating it as a model', async metadata => {
  await expect(new CanonicalDesktopProtocol().settle('session.resume', {}, snapshot(), vi.fn().mockResolvedValue(metadata)))
    .rejects.toThrow('Invalid session info response')
})


test('whitespace-only model is replaced by authoritative session info', async () => {
  const value = { ...snapshot(), info: { ...snapshot().info, model: '   ' } }
  const result = await new CanonicalDesktopProtocol().settle('session.resume', {}, value, vi.fn().mockResolvedValue({ model: 'gpt-6.1-sol' }))
  expect(result.info.model).toBe('gpt-6.1-sol')
})
