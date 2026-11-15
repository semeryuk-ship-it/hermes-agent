"""Named Codex usage stays read-only and belongs to the selected login."""
import base64
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("named_codex", ROOT / "plugins/model-providers/codex-accounts/__init__.py")
assert SPEC is not None and SPEC.loader is not None
PLUGIN = importlib.util.module_from_spec(SPEC)
import sys
sys.modules[SPEC.name] = PLUGIN
SPEC.loader.exec_module(PLUGIN)

def token(email):
    payload = base64.urlsafe_b64encode(json.dumps({"https://api.openai.com/profile": {"email": email}}).encode()).decode().rstrip("=")
    return "header." + payload + ".signature"

class NamedUsageTest(unittest.TestCase):
    def test_selected_account_has_read_only_usage_hook(self):
        profile = PLUGIN.NamedCodexProfile(name="codex-test", expected_email="test@example.com")
        with patch("agent.account_usage._fetch_codex_account_usage_read_only", return_value=None) as fetch:
            profile.fetch_account_usage(api_key=token("test@example.com"))
            fetch.assert_called_once_with(PLUGIN.BASE_URL, token("test@example.com"))

    def test_native_identity_does_not_override_named_pool_cache_key(self):
        from agent.account_usage import AccountUsageSnapshot
        from datetime import UTC, datetime
        profile = PLUGIN.NamedCodexProfile(name="codex-test", expected_email="test@example.com")
        native = AccountUsageSnapshot(provider="openai-codex", source="usage_api", fetched_at=datetime.now(UTC), identity="codex:native:principal")
        with patch("agent.account_usage._fetch_codex_account_usage_read_only", return_value=native):
            result = profile.fetch_account_usage(api_key=token("test@example.com"))
            self.assertEqual(result.provider, "codex-test")
            self.assertIsNone(result.identity)

    def test_missing_or_other_account_never_falls_back(self):
        profile = PLUGIN.NamedCodexProfile(name="codex-test", expected_email="test@example.com")
        with patch("agent.account_usage._fetch_codex_account_usage_read_only") as fetch:
            self.assertIsNone(profile.fetch_account_usage())
            with self.assertRaises(Exception):
                profile.fetch_account_usage(api_key=token("other@example.com"))
            fetch.assert_not_called()

if __name__ == "__main__":
    unittest.main()
