"""Query available Codex models for the configured account."""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_CRED = _REPO_ROOT / "config" / "codex-credentials.json"


def _cred_path() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    override = os.environ.get("CODEX_CREDENTIALS_PATH")
    return Path(override) if override else _DEFAULT_CRED


def load_token(cred_path: Path) -> tuple[str, str]:
    if not cred_path.exists():
        raise FileNotFoundError(
            f"Credentials not found: {cred_path}\n"
            "Place ChatGPT OAuth creds in config/codex-credentials.json "
            "(gitignored), set CODEX_CREDENTIALS_PATH, or pass a path as argv[1]."
        )
    data = json.loads(cred_path.read_text(encoding="utf-8"))
    if "access_token" in data:
        return data["access_token"], data.get("account_id", "")
    creds = data["accounts"][0]["credentials"]
    return creds["access_token"], creds["account_id"]


def main() -> int:
    cred_path = _cred_path()
    token, account_id = load_token(cred_path)
    headers = {
        "Authorization": f"Bearer {token}",
        "chatgpt-account-id": account_id,
    }
    for ver in ("0.114.0", "0.1.0", "1.0.0"):
        url = f"https://chatgpt.com/backend-api/codex/models?client_version={ver}"
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"\n=== client_version={ver} OK ===")
                print(resp.read().decode()[:2000])
        except urllib.error.HTTPError as e:
            print(f"\n=== client_version={ver} {e.code} ===")
            print(e.read().decode()[:500])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
