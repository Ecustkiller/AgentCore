"""REST path contract — OpenAPI templates ↔ client path literals."""

from scripts.validate_rest_paths import _normalize, main


def test_normalize_path_param_and_query_suffix() -> None:
    assert (
        _normalize("/v1/conversations/${conversationId}/messages")
        == "/v1/conversations/{param}/messages"
    )
    assert (
        _normalize(
            "/v1/conversations/${encodeURIComponent(conversationId)}/audit${q}"
        )
        == "/v1/conversations/{param}/audit"
    )
    assert (
        _normalize("/v1/standing-task-runs?limit=1") == "/v1/standing-task-runs"
    )
    # Trailing-slash prefixes are not concrete routes.
    assert _normalize("/v1/auth/") is None


def test_rest_paths_aligned() -> None:
    main()
