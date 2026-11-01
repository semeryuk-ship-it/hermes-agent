import { JsonRpcGatewayClient } from '@hermes/shared'
import { afterEach, expect, test, vi } from 'vitest'

import { HermesGateway } from './client'

afterEach(() => { vi.restoreAllMocks() })

test.each([60, 120])('compress follow-up spends only the remaining caller budget after %i ms', async elapsed => {
  let now = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(JsonRpcGatewayClient.prototype, 'connect').mockResolvedValue()
  const calls: Array<{ method: string; timeout?: number; signal?: AbortSignal }> = []
  const snapshot = { session_id: 's', revision: 1, execution_generation: 2, messages: [], info: {} }
  vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockImplementation(async (method, _params, timeout, signal) => {
    calls.push({ method, timeout, signal })

    if (method === 'session.mutate') {
      now += elapsed

      return { session_id: 's', revision: 2, operation: 'compress', message_count: 0 } as never
    }

    return snapshot as never
  })
  const client = new HermesGateway()
  await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=fixture')
  await client.request('session.resume', { session_id: 's', profile: 'sibling' })
  calls.length = 0
  const controller = new AbortController()
  const compression = client.request('session.compress', { session_id: 's', profile: 'sibling' }, 100, controller.signal)

  if (elapsed < 100) {
    await expect(compression).resolves.toHaveProperty('messages')
    expect(calls).toEqual([
      { method: 'session.mutate', timeout: 100, signal: controller.signal },
      { method: 'session.resume', timeout: 40, signal: controller.signal }
    ])
  } else {
    await expect(compression).rejects.toThrow('timed out')
    expect(calls).toHaveLength(1)
  }

  client.close()
})

test('the prerequisite attachment shares the caller deadline and cancellation', async () => {
  let now = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(JsonRpcGatewayClient.prototype, 'connect').mockResolvedValue()
  const calls: Array<{ method: string; timeout?: number; signal?: AbortSignal }> = []
  vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockImplementation(async (method, _params, timeout, signal) => {
    calls.push({ method, timeout, signal })

    if (method === 'session.resume') {
      now += 60

      return { session_id: 's', revision: 1, execution_generation: 2, messages: [], info: {} } as never
    }

    return { ref: { session_id: 's' }, admission_id: 'a', status: 'queued' } as never
  })
  const client = new HermesGateway()
  await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=fixture')
  const controller = new AbortController()

  try {
    await client.request('prompt.submit', { session_id: 's', submission_id: 'one', text: 'hello' }, 100, controller.signal)
    expect(calls).toEqual([
      { method: 'session.resume', timeout: 100, signal: controller.signal },
      { method: 'prompt.submit', timeout: 40, signal: controller.signal }
    ])
  } finally { client.close() }
})

test('a prerequisite attachment resolves the launch profile alias before preparing a mutation', async () => {
  vi.spyOn(JsonRpcGatewayClient.prototype, 'connect').mockResolvedValue()
  const calls: Array<{ method: string; params: unknown }> = []
  vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockImplementation(async (method, params) => {
    calls.push({ method, params })

    if (method === 'session.resume') {
      return { session_id: 's', revision: 3, execution_generation: 2, replay_epoch: 'named-owner',
        messages: [], info: { profile_name: 'work', profile_id: '/profiles/work' } } as never
    }

    return { session_id: 's', revision: 4, operation: 'branch', branched_session_id: 'child', copied_messages: 0 } as never
  })
  const client = new HermesGateway()
  await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=fixture')

  try {
    await expect(client.request('session.branch_stored', { parent_session_id: 's' })).resolves.toMatchObject({ session_id: 'child' })
    expect(calls[1]).toMatchObject({ method: 'session.mutate', params: { profile: 'work', expected_revision: 3 } })
  } finally { client.close() }
})

test('a zero timeout is no deadline on the canonical socket: the request is sent and waits (F3)', async () => {
  // onboarding.state / onboarding.start pass 0 (NO_DEADLINE): the shared channel arms no timer for 0.
  // The canonical wrapper used to read 0 as an already-spent deadline and throw before sending, so the
  // first-run decision settled at once and the setup card covered a configured home until readiness answered.
  vi.spyOn(JsonRpcGatewayClient.prototype, 'connect').mockResolvedValue()
  const calls: Array<{ method: string; timeout?: number }> = []
  let answer: (value: unknown) => void = () => undefined

  vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockImplementation(async (method, _params, timeout) => {
    calls.push({ method, timeout })

    return new Promise(resolve => { answer = resolve }) as never
  })
  const client = new HermesGateway()
  await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=fixture')

  try {
    const state = client.request('onboarding.state', {}, 0)
    await vi.waitFor(() => expect(calls).toEqual([{ method: 'onboarding.state', timeout: 0 }]))
    answer({ run: false, eligible: false })
    await expect(state).resolves.toEqual({ run: false, eligible: false })
  } finally { client.close() }
})

test('missing resume metadata uses the same profile, deadline and cancellation for info', async () => {
  let now = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(JsonRpcGatewayClient.prototype, 'connect').mockResolvedValue()
  const calls: Array<{ method: string; params: unknown; timeout?: number; signal?: AbortSignal }> = []
  vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockImplementation(async (method, params, timeout, signal) => {
    if (method === 'session.resume') {
      calls.push({ method, params, timeout, signal }); now += 40
      return { session_id: 'existing', revision: 7, execution_generation: 3, messages: [],
        info: { desktop_protocol: 'hermes-gateway-v1' } } as never
    }
    if (method === 'session.info') {
      calls.push({ method, params, timeout, signal })
      return { model: 'gpt-6.1-sol' } as never
    }
    return {} as never
  })
  const client = new HermesGateway()
  const controller = new AbortController()
  try {
    await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=fixture&desktop_remote=ssh')
    const value = await client.request<{ info: { model: string } }>('session.resume', { session_id: 'existing', profile: 'mira' }, 100, controller.signal)
    expect(value.info.model).toBe('gpt-6.1-sol')
    expect(calls.map(call => ({ method: call.method, timeout: call.timeout, signal: call.signal }))).toEqual([
      { method: 'session.resume', timeout: 100, signal: controller.signal },
      { method: 'session.info', timeout: 60, signal: controller.signal }
    ])
    expect(calls[1].params).toEqual({ session_id: 'existing', profile: 'mira' })
  } finally {client.close()}
})

test('an info refusal preserves attachment and pending prompt ownership across reconnect', async () => {
  vi.spyOn(JsonRpcGatewayClient.prototype, 'connect').mockResolvedValue()
  const calls: string[] = []
  const replies: unknown[] = []
  vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockImplementation(async (method, params) => {
    calls.push(method)
    if (method === 'session.resume') {return { session_id: 'existing', revision: 7, execution_generation: 3, replay_epoch: 'epoch', subscription_id: 'subscription', messages: [], prompts: [{ kind: 'approval', prompt_id: 'pending', execution_generation: 3 }], info: { desktop_protocol: 'hermes-gateway-v1', profile_name: 'mira' } } as never}
    if (method === 'session.info') {throw new Error('permission_denied')}
    if (method === 'approval.respond') {replies.push(params)}
    return {} as never
  })
  const client = new HermesGateway()
  const approvals: unknown[] = []
  client.onRequest(request => {approvals.push(request)})
  try {
    await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=fixture&desktop_remote=ssh')
    await expect(client.request('session.resume', { session_id: 'existing', profile: 'default' })).rejects.toThrow('permission_denied')
    await client.request('session.interrupt', { session_id: 'existing', profile: 'mira' })
    expect(calls.filter(method => method === 'session.resume')).toHaveLength(1)
    expect(approvals).toHaveLength(1)
    await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=second&desktop_remote=ssh')
    await expect(client.request('session.resume', { session_id: 'existing', profile: 'default' })).rejects.toThrow('permission_denied')
    expect(approvals).toHaveLength(2)
    const answer = (card: unknown) => (card as { respond: (value: { choice: string }) => void }).respond({ choice: 'once' })
    answer(approvals[0])
    expect(replies).toHaveLength(0)
    answer(approvals[1])
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toMatchObject({ session_id: 'existing', profile: 'mira', execution_generation: 3 })
    expect(calls.filter(method => method === 'session.resume')).toHaveLength(2)
  } finally {client.close()}
})

test.each(['', '   '])('malformed attachment identity %j is never retained', async sessionId => {
  vi.spyOn(JsonRpcGatewayClient.prototype, 'connect').mockResolvedValue()
  let infoCalls = 0
  vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockImplementation(async method => {
    if (method === 'session.resume') {return { session_id: sessionId, revision: 7, execution_generation: 3,
      replay_epoch: 'epoch', subscription_id: 'subscription', info: { desktop_protocol: 'hermes-gateway-v1' } } as never}
    if (method === 'session.info') {infoCalls++}
    return {} as never
  })
  const client = new HermesGateway()
  try {
    await client.connect('ws://localhost/api/ws?native_dial=fixture&ticket=fixture&desktop_remote=ssh')
    await expect(client.request('session.resume', { session_id: 'requested', profile: 'mira' })).rejects.toThrow('Invalid attached session identity')
    expect(infoCalls).toBe(0)
    expect((client as unknown as { attached: Set<string> }).attached.size).toBe(0)
  } finally {client.close()}
})
