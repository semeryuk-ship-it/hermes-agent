import type { ModelOptionProvider, ModelOptionsResult } from '@hermes/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { usageWindows } from '@/lib/provider-limit'

import { anthropicUsagePoll, AnthropicUsageSummary } from './anthropic-usage-summary'

const NOW = Date.parse('2026-10-31T09:00:00Z')
const RESET = '2026-10-31T13:00:00Z'

const provider = (windows: NonNullable<ModelOptionProvider['usage']>['windows']): ModelOptionProvider => ({
  slug: 'anthropic',
  name: 'Anthropic',
  models: ['claude-opus-5-5'],
  usage: { windows }
})

const view = (row: ModelOptionProvider) => (
  <I18nProvider configClient={null} initialLocale="ru">
    <AnthropicUsageSummary provider={row} />
  </I18nProvider>
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('always shows healthy account windows and distinguishes the missing Opus cap', () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  render(
    view(
      provider([
        { label: 'Current session', used_percent: 8, resets_at: RESET, scope: 'account' },
        { label: 'Current week', used_percent: 2, resets_at: RESET, scope: 'account' }
      ])
    )
  )
  expect(screen.getByText(/5 часов: осталось 92%/)).toBeTruthy()
  expect(screen.getByText(/Неделя: осталось 98%/)).toBeTruthy()
  expect(screen.getByText('Opus: нет данных об отдельном лимите')).toBeTruthy()
  expect(screen.queryByText(/почти исчерпал/)).toBeNull()
})

it('a depleted Opus cap does not become the account cap', () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)

  const row = provider([
    { label: 'Current week', used_percent: 10, resets_at: RESET, scope: 'account' },
    { label: 'Opus week', used_percent: 100, resets_at: RESET, scope: 'model' }
  ])

  render(view(row))
  expect(screen.getByText(/Неделя: осталось 90%/)).toBeTruthy()
  expect(screen.getByText(/Opus, неделя: осталось 0%/)).toBeTruthy()
  expect(usageWindows(row, NOW)?.map(w => w.remaining)).toEqual([90])
})

it('missing, expired and invalid telemetry never becomes a full gauge', () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  render(
    view(
      provider([
        { label: 'Current week', used_percent: 0, resets_at: '2026-10-30T13:00:00Z' },
        { label: 'Current session', used_percent: Number.NaN, resets_at: RESET }
      ])
    )
  )
  expect(screen.getByText(/Лимиты аккаунта: Данные об использовании недоступны/)).toBeTruthy()
  expect(screen.queryByText(/100%/)).toBeNull()
})

it('never combines a pool observation into a current-account number', () => {
  const row = provider([{ label: 'Current week', used_percent: 0, resets_at: RESET }])
  row.usage!.accounts = [{ id: 'another', state: 'ready', windows: [] }]
  render(view(row))
  expect(screen.queryByText(/100%/)).toBeNull()
})

it('bounds cache warmup polling and then refreshes every five minutes', () => {
  const data = { providers: [provider([])] } as ModelOptionsResult
  delete data.providers[0].usage
  expect(anthropicUsagePoll(data, 1)).toBe(2000)
  expect(anthropicUsagePoll(data, 4)).toBe(300000)
  expect(anthropicUsagePoll(data, 5)).toBe(2000)
  expect(anthropicUsagePoll(data, 6)).toBe(300000)
  expect(anthropicUsagePoll(data, 5, true)).toBe(300000)
  expect(anthropicUsagePoll(undefined, 1)).toBe(false)
})
