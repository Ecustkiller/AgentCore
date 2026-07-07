"""Test OpenAI Responses API and Codex backend for ChatGPT OAuth tokens."""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

CRED_PATHS = [
    Path(__file__).resolve().parent.parent / "api" / "codex-credentials.json",
    Path(__file__).resolve().parent.parent / "api" / "codex-credentials.json",
]
CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses"
OPENAI_UPSTREAM = "https://api.openai.com/v1/responses"


def load_creds() -> tuple[str, str]:
    for path in CRED_PATHS:
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if "access_token" in data:
            return data["access_token"], data.get("account_id", "")
        creds = data["accounts"][0]["credentials"]
        return creds["access_token"], creds.get("account_id", "")
    raise FileNotFoundError(f"No credentials found in {CRED_PATHS}")


def post(url: str, token: str, account_id: str, model: str, label: str) -> None:
    if "codex" in url:
        body = {
            "model": model,
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "say hi in one word"}],
                }
            ],
            "stream": True,
            "store": False,
            "instructions": "You are helpful.",
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "ChatGPT-Account-ID": account_id,
        }
    else:
        body = {"model": model, "input": "say hi in one word"}
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            print(f"\n=== {label} / {model}: {resp.status} OK ===")
            print(raw[:500])
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        print(f"\n=== {label} / {model}: {e.code} FAILED ===")
        try:
            print(json.dumps(json.loads(raw), indent=2)[:600])
        except json.JSONDecodeError:
            print(raw[:600])


def main() -> int:
    token, account_id = load_creds()
    print(f"Loaded token ({len(token)} chars), account_id={account_id}")

    for model in ["gpt-4o", "o4-mini", "gpt-5.4", "gpt-5.5"]:
        post(OPENAI_UPSTREAM, token, account_id, model, "api.openai.com")
    for model in ["gpt-4o", "gpt-5.4", "gpt-5.5"]:
        post(CODEX_UPSTREAM, token, account_id, model, "codex backend")

    api_key = "REDACTED_PLATFORM_API_KEY"
    for model in ["gpt-4o", "gpt-5.4"]:
        req = urllib.request.Request(
            "http://localhost:8080/v1/responses",
            data=json.dumps({"model": model, "input": "say hi in one word"}).encode(),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                print(f"\n=== sub2api / {model}: {resp.status} OK ===")
                print(resp.read().decode()[:300])
        except urllib.error.HTTPError as e:
            print(f"\n=== sub2api / {model}: {e.code} ===")
            print(e.read().decode()[:300])
        except urllib.error.URLError as e:
            print(f"\n=== sub2api unreachable: {e} ===")
            break

    return 0


if __name__ == "__main__":
    sys.exit(main())
