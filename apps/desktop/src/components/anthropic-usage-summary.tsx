import type { ModelOptionProvider, ModelOptionsResult, ProviderUsageWindow } from '@hermes/shared'

import { useI18n } from '@/i18n'
import { formatReset } from '@/lib/provider-limit'

export function anthropicUsagePoll(
  data: ModelOptionsResult | undefined,
  updates: number,
  failed = false
): false | number {
  const provider = data?.providers?.find(row => row.slug === 'anthropic')

  if (!provider) {
    return false
  }

  // Every catalog read warms usage asynchronously. Follow each five-minute
  // read once, even if it returned an older valid snapshot. Failures back off.
  if (failed) {
    return 300_000
  }

  return (updates < 4 && !provider.usage) || updates % 2 === 1 ? 2_000 : 300_000
}

/** Account and model caps are distinct; missing telemetry is never a full gauge. */
export function AnthropicUsageSummary({ provider }: { provider: ModelOptionProvider }) {
  const { t } = useI18n()
  const copy = t.shell.modelMenu

  if (provider.slug !== 'anthropic') {
    return null
  }

  // A provider observation cannot identify the active member of a credential pool.
  const windows = provider.usage?.accounts?.length ? [] : (provider.usage?.windows ?? [])

  const current = windows.filter(window => {
    const reset = window.resets_at ? Date.parse(window.resets_at) : null

    return (
      Number.isFinite(window.used_percent) &&
      window.used_percent >= 0 &&
      window.used_percent <= 100 &&
      (reset === null || (Number.isFinite(reset) && reset > Date.now()))
    )
  })

  const account = current.filter(window => window.scope !== 'model')
  const opus = current.find(window => window.scope === 'model' && /opus/i.test(window.label))

  const label = (window: ProviderUsageWindow) => {
    if (window.scope === 'model') {
      return copy.opusUsage
    }

    const labels: Record<string, string> = { 'Current session': copy.sessionUsage, 'Current week': copy.weekUsage }

    return labels[window.label] ?? window.label
  }

  const line = (window: ProviderUsageWindow) =>
    copy.usageWindow(
      label(window),
      Math.round(100 - window.used_percent),
      window.resets_at ? formatReset(Date.parse(window.resets_at)) : null
    )

  return (
    <div
      aria-label={copy.accountUsage}
      className="grid gap-0.5 px-2 pb-1.5 text-xs leading-snug tabular-nums text-(--ui-text-secondary)"
    >
      {account.length ? (
        account.map(window => <div key={window.label}>{line(window)}</div>)
      ) : (
        <div>
          {copy.accountUsage}: {copy.poolUnknown}
        </div>
      )}
      <div className="text-(--ui-text-tertiary)">{opus ? line(opus) : copy.opusUsageUnavailable}</div>
    </div>
  )
}
