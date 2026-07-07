"""Quick model test with proper Codex request format."""
import json
import urllib.error
import urllib.request
from pathlib import Path

CRED = json.loads(
    (Path(__file__).resolve().parent.parent / "api" / "cpa-to-sub2api-20260707143913.json").read_text()
)
acc = CRED["accounts"][0]["credentials"]
TOKEN, AID = acc["access_token"], acc["account_id"]

for model in ["gpt-5.4", "gpt-5.5", "gpt-4o", "gpt-5.2", "o4-mini"]:
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
    req = urllib.request.Request(
        "https://chatgpt.com/backend-api/codex/responses",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "ChatGPT-Account-ID": AID,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            print(f"{model}: OK {raw[:100]}")
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read().decode()).get("detail", "?")
        print(f"{model}: FAIL {e.code} {detail}")
