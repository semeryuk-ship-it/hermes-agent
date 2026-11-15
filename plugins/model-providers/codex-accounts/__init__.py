"""Named Codex accounts. Each provider owns one OAuth pool; never rotate another account's grant."""

import base64
from dataclasses import dataclass, replace
from functools import partial
import json
import uuid

from providers import register_provider
from providers.base import ProviderProfile

BASE_URL = "https://chatgpt.com/backend-api/codex"
MODELS = ("gpt-6.1-sol", "gpt-6.1-terra")


def _email(token):
    try:
        claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))
        return str(claims.get("email") or claims.get("https://api.openai.com/profile", {}).get("email") or "").lower()
    except (ValueError, IndexError, TypeError):
        return ""


def _require_account(token, email):
    from hermes_cli.auth_constants import AuthError
    if _email(token) != email.lower():
        raise AuthError("This login belongs to another account; the selected account was not changed.",
                        code="codex_account_mismatch", relogin_required=True)


def _refresh(entry, *, email):
    from hermes_cli.auth_codex import refresh_codex_oauth_pure
    _require_account(entry.access_token, email)
    updated = refresh_codex_oauth_pure(entry.access_token, entry.refresh_token)
    _require_account(updated["access_token"], email)
    claims = json.loads(base64.urlsafe_b64decode(updated["access_token"].split(".")[1] + "==="))
    return {**updated, "expires_at_ms": int(claims["exp"]) * 1000}


def _auth(action, args, *, provider, email, label):
    from agent.credential_pool import load_pool
    if action == "status":
        pool = load_pool(provider)
        print(json.dumps({"provider": provider, "email": email, "logged_in": pool.has_credentials()}))
        return True
    if action == "refresh":
        pool = load_pool(provider)
        if pool.try_refresh_matching() is None:
            raise SystemExit("Account refresh failed; sign in to this account again.")
        return True
    if action != "add":
        return False
    from hermes_cli.auth_codex_browser import codex_oauth_login
    from hermes_cli.auth import _auth_store_lock, _load_auth_store, _save_auth_store
    creds = codex_oauth_login(args)
    tokens = creds["tokens"]
    _require_account(tokens["access_token"], email)
    claims = json.loads(base64.urlsafe_b64decode(tokens["access_token"].split(".")[1] + "==="))
    with _auth_store_lock():
        store = _load_auth_store()
        store.setdefault("credential_pool", {})[provider] = [{
            "id": uuid.uuid4().hex[:6], "label": label, "priority": 0, "auth_type": "oauth",
            "source": "manual:codex_account", "base_url": BASE_URL, **tokens,
            "last_refresh": creds.get("last_refresh"), "expires_at_ms": int(claims["exp"]) * 1000,
        }]
        _save_auth_store(store)
    print(f"Signed in to {label}")
    return True


@dataclass
class NamedCodexProfile(ProviderProfile):
    expected_email: str = ""

    def fetch_account_usage(self, *, base_url=None, api_key=None):
        # Never resolve a different provider's credential or rotate a token for a read.
        if not api_key:
            return None
        _require_account(api_key, self.expected_email)
        from agent.account_usage import _fetch_codex_account_usage_read_only
        snapshot = _fetch_codex_account_usage_read_only(BASE_URL, api_key)
        # Named providers use credential-fingerprint cache keys, not native Codex principal keys.
        return replace(snapshot, provider=self.name, identity=None) if snapshot is not None else None


def register_accounts():
    from hermes_constants import get_hermes_home
    import hermes_yaml as yaml
    path = get_hermes_home() / "config.yaml"
    config = yaml.safe_load(path.read_text(encoding="utf-8-sig")) if path.is_file() else {}
    accounts = (config or {}).get("codex_accounts", {})
    if not isinstance(accounts, dict):
        return
    for provider, account in accounts.items():
        if not isinstance(provider, str) or not provider.startswith("codex-") or not isinstance(account, dict):
            continue
        email, label = account.get("email"), account.get("name")
        if not isinstance(email, str) or "@" not in email or not isinstance(label, str) or not label.strip():
            continue
        register_provider(NamedCodexProfile(
            name=provider, display_name=label, api_mode="codex_responses", auth_type="oauth_external",
            expected_email=email,
            base_url=BASE_URL, fallback_models=MODELS, supports_model_listing=False,
            auth_handler=partial(_auth, provider=provider, email=email, label=label),
            refresh_credential=partial(_refresh, email=email),
        ))


register_accounts()
