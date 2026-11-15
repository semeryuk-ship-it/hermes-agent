# Named Codex weekly quota display

The named `codex-*` subscription providers now implement the existing read-only account-usage hook. Requests use only the explicitly supplied credential. Missing credentials never fall back to another login; a mismatched account is rejected. Native Codex identity is cleared on the returned snapshot because named provider cache slots use credential fingerprints rather than the native provider's principal key.

The provider status chip shows the single named account's Weekly remaining percentage at every value, including 0 and 100. Unknown data does not produce a fabricated percentage. Multi-account generic pools retain their existing count and tooltip behavior.

Installed both existing provider plugin copies under the active Hermes home. The installed Desktop renderer was patched only at the existing pool-chip branch; no unrelated pending frontend changes were packaged. The matching source change and targeted installer are in this repository. The installer backs up the archive and affected unpacked JS, updates the ASAR size/integrity metadata without shifting payload, and reads back the exact target.

Verification: 9 frontend tests pass; 3 provider tests pass; 5 checks exercise the installed generated branch. A fresh Python process loaded the installed NamedCodexProfile and successfully fetched and cached real Weekly usage for the selected provider. Reading usage does not change authentication storage or redeem resets.

Activation remains pending: the already-running gateway has previously imported provider modules, and the running renderer has its previous JS in memory. Fully exit and reopen Hermes externally. Do not claim verification of the visible menu until that activation and a live menu read. No current app or gateway was killed or restarted.

Desktop rollback backup: `C:/Users/user/AppData/Local/hermes/backups/named-codex-weekly-1794732469692/`.
