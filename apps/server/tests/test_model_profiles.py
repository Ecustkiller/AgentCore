"""Unit tests for dynamic platform system presets (uuid5 projection)."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentcore.llm.model_profiles import (
    LlmModelProfileService,
    is_system_profile_id,
    platform_preset_id,
    resolve_system_preset_main,
    system_presets,
    system_profile_default_id,
)

# Former hardcoded product UUIDs — must NOT be recognized as system presets.
_LEGACY_SYSTEM_PROFILE_52 = "00000000-0000-4000-8000-000000000011"
_LEGACY_SYSTEM_PROFILE_GROK = "00000000-0000-4000-8000-000000000012"


def _glm_preset_id() -> str:
    return platform_preset_id("glm-5.2")


def test_platform_preset_id_is_stable_uuid5():
    expected = str(
        uuid.uuid5(uuid.NAMESPACE_URL, "agentcore:platform-preset:glm-5.2")
    )
    assert platform_preset_id("glm-5.2") == expected
    assert platform_preset_id("glm-5.2") == platform_preset_id("glm-5.2")
    assert platform_preset_id("glm-5.2") != platform_preset_id("grok-4.5")


def test_system_presets_project_from_listable_catalog(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2", "grok-4.5"],
    )
    presets = system_presets()
    assert list(presets.values()) == ["glm-5.2", "grok-4.5"]
    assert presets[_glm_preset_id()] == "glm-5.2"
    assert presets[platform_preset_id("grok-4.5")] == "grok-4.5"
    assert is_system_profile_id(_glm_preset_id())
    assert not is_system_profile_id(_LEGACY_SYSTEM_PROFILE_52)
    assert not is_system_profile_id(_LEGACY_SYSTEM_PROFILE_GROK)
    assert not is_system_profile_id("00000000-0000-4000-8000-000000000002")


def test_system_profile_default_prefers_platform_model(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["grok-4.5", "glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.llm.model_profiles.settings.platform_model",
        "glm-5.2",
    )
    assert system_profile_default_id() == _glm_preset_id()


def test_system_profile_default_falls_to_first_when_platform_model_absent(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["grok-4.5", "glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.llm.model_profiles.settings.platform_model",
        "not-in-list",
    )
    assert system_profile_default_id() == platform_preset_id("grok-4.5")


def test_resolve_system_preset_main_is_fixed(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    sel = resolve_system_preset_main(_glm_preset_id())
    assert sel.model == "glm-5.2"
    assert sel.origin == "platform"
    assert sel.provider_id is None


@pytest.mark.asyncio
async def test_list_profiles_hides_missing_catalog_models(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: [],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._repo.list_for_user = AsyncMock(return_value=[])  # type: ignore[method-assign]

    views = await svc.list_profiles("u1")
    assert views == []


@pytest.mark.asyncio
async def test_list_profiles_hides_system_when_platform_billing_off(monkeypatch):
    """byok + free-tier off: allowlist may still list glm-5.2 — presets must hide."""
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: False,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._repo.list_for_user = AsyncMock(return_value=[])  # type: ignore[method-assign]

    views = await svc.list_profiles("u1")
    assert views == []


@pytest.mark.asyncio
async def test_list_profiles_marks_default_when_present(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.llm.model_profiles.settings.platform_model",
        "glm-5.2",
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._repo.list_for_user = AsyncMock(return_value=[])  # type: ignore[method-assign]

    views = await svc.list_profiles("u1")
    assert [v.id for v in views] == [_glm_preset_id()]
    assert views[0].is_default is True
    assert views[0].name == "GLM-5.2"
    assert views[0].main.model == "glm-5.2"
    assert views[0].worker is None
    assert views[0].background is None


@pytest.mark.asyncio
async def test_list_profiles_projects_multiple_models(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2", "grok-4.5"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.llm.model_profiles.settings.platform_model",
        "glm-5.2",
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._repo.list_for_user = AsyncMock(return_value=[])  # type: ignore[method-assign]

    views = await svc.list_profiles("u1")
    assert [v.main.model for v in views] == ["glm-5.2", "grok-4.5"]
    assert views[0].is_default is True
    assert views[1].name == "Grok 4.5"


@pytest.mark.asyncio
async def test_expand_none_and_dangling_fall_back_to_platform_default(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.llm.model_profiles.settings.platform_model",
        "glm-5.2",
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._repo.get = AsyncMock(return_value=None)  # type: ignore[method-assign]

    expanded = await svc.expand("u1", None)
    assert expanded.profile_id == _glm_preset_id()
    assert expanded.main.model == "glm-5.2"
    assert expanded.name == "GLM-5.2"

    dangling = await svc.expand("u1", "00000000-0000-4000-8000-000000000002")
    assert dangling.profile_id == _glm_preset_id()
    assert dangling.main.model == "glm-5.2"


@pytest.mark.asyncio
async def test_expand_legacy_hardcoded_uuid_falls_back_to_default(monkeypatch):
    """Old …0011 / …0012 ids are not system presets → dangling → PLATFORM_MODEL preset."""
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.llm.model_profiles.settings.platform_model",
        "glm-5.2",
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._repo.get = AsyncMock(return_value=None)  # type: ignore[method-assign]

    for legacy in (_LEGACY_SYSTEM_PROFILE_52, _LEGACY_SYSTEM_PROFILE_GROK):
        expanded = await svc.expand("u1", legacy)
        assert expanded.profile_id == _glm_preset_id()
        assert expanded.main.model == "glm-5.2"


@pytest.mark.asyncio
async def test_set_default_rejects_unavailable_system_preset(monkeypatch):
    from agentcore.core.errors import ValidationError

    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: False,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    svc = LlmModelProfileService(MagicMock())
    with pytest.raises(ValidationError, match="不可用"):
        await svc.set_default("u1", _glm_preset_id())


@pytest.mark.asyncio
async def test_ensure_rejects_unavailable_system_preset(monkeypatch):
    from agentcore.core.errors import ValidationError

    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: False,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    svc = LlmModelProfileService(MagicMock())
    with pytest.raises(ValidationError, match="不可用"):
        await svc.ensure_profile_usable("u1", _glm_preset_id())


@pytest.mark.asyncio
async def test_list_marks_user_default_when_system_pin_dormant(monkeypatch):
    """DB pin on invisible system preset → list marks first visible user combo (no DB write)."""
    from types import SimpleNamespace

    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: False,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    user_row = SimpleNamespace(
        id="user-combo-1",
        name="我的组合",
        kind="user",
        main_origin="byok",
        main_model="gpt-4o",
        main_provider_id="p1",
        worker_origin=None,
        worker_model=None,
        worker_provider_id=None,
        background_origin=None,
        background_model=None,
        background_provider_id=None,
        vision_origin=None,
        vision_model=None,
        vision_provider_id=None,
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=_glm_preset_id())  # type: ignore[method-assign]
    svc._repo.list_for_user = AsyncMock(return_value=[user_row])  # type: ignore[method-assign]
    svc._users.set_default_model_profile = AsyncMock()  # type: ignore[method-assign]

    views = await svc.list_profiles("u1")
    assert len(views) == 1
    assert views[0].id == "user-combo-1"
    assert views[0].is_default is True
    svc._users.set_default_model_profile.assert_not_awaited()


@pytest.mark.asyncio
async def test_expand_dormant_system_falls_to_byok_coherent(monkeypatch):
    """Unavailable system preset → BYOK selection; name/origin match (not GLM-5.2 + byok)."""
    from agentcore.llm.resolve import ModelSelection

    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: False,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "agentcore.llm.model_profiles._provider_first_fallback",
        AsyncMock(
            return_value=ModelSelection(
                model="user-flash", origin="byok", provider_id="p1"
            )
        ),
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=_glm_preset_id())  # type: ignore[method-assign]
    svc._repo.list_for_user = AsyncMock(return_value=[])  # type: ignore[method-assign]
    svc._repo.get = AsyncMock(return_value=None)  # type: ignore[method-assign]

    expanded = await svc.expand("u1", None)
    assert expanded.main.origin == "byok"
    assert expanded.main.model == "user-flash"
    assert expanded.main.provider_id == "p1"
    assert expanded.kind == "implicit"
    assert expanded.vision is None
    assert "GLM-5.2" not in expanded.name
    assert "glm-5.2" not in expanded.name
    assert expanded.profile_id != _glm_preset_id()


@pytest.mark.asyncio
async def test_expand_user_profile_includes_vision_slot(monkeypatch):
    """User combo with vision columns → expand surfaces vision; empty stays None."""
    from types import SimpleNamespace

    from agentcore.llm.resolve import ModelSelection

    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.platform_catalog_visible",
        lambda: True,
    )

    async def _live(_session, _user_id, slot):
        return ModelSelection(
            model=slot.model, origin=slot.origin, provider_id=slot.provider_id
        )

    monkeypatch.setattr(
        "agentcore.llm.model_profiles._live_selection",
        _live,
    )

    row = SimpleNamespace(
        id="combo-v",
        name="识图组合",
        kind="user",
        main_origin="byok",
        main_model="gpt-4o",
        main_provider_id="p-main",
        worker_origin=None,
        worker_model=None,
        worker_provider_id=None,
        background_origin=None,
        background_model=None,
        background_provider_id=None,
        vision_origin="byok",
        vision_model="qwen-vl-max",
        vision_provider_id="p-vision",
    )
    svc = LlmModelProfileService(MagicMock())
    svc._default_id = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._repo.get = AsyncMock(return_value=row)  # type: ignore[method-assign]

    expanded = await svc.expand("u1", "combo-v")
    assert expanded.vision is not None
    assert expanded.vision.model == "qwen-vl-max"
    assert expanded.vision.origin == "byok"
    assert expanded.vision.provider_id == "p-vision"

    row_no_vision = SimpleNamespace(**{**row.__dict__, "vision_origin": None, "vision_model": None, "vision_provider_id": None})
    svc._repo.get = AsyncMock(return_value=row_no_vision)  # type: ignore[method-assign]
    expanded2 = await svc.expand("u1", "combo-v")
    assert expanded2.vision is None


@pytest.mark.asyncio
async def test_system_preset_view_vision_always_null(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.catalog.platform_listable_model_ids",
        lambda: ["glm-5.2"],
    )
    svc = LlmModelProfileService(MagicMock())
    view = svc._view_system(_glm_preset_id(), is_default=True)
    assert view.vision is None


@pytest.mark.asyncio
async def test_validate_slot_platform_requires_catalog_visible(monkeypatch):
    from agentcore.core.errors import ValidationError
    from agentcore.llm.model_profiles import ProfileSlot

    monkeypatch.setattr(
        "agentcore.billing.preference.platform_billing_selectable",
        lambda: False,
    )
    monkeypatch.setattr(
        "agentcore.billing.preference.is_platform_available",
        lambda: True,
    )
    svc = LlmModelProfileService(MagicMock())
    with pytest.raises(ValidationError, match="不可用平台模型"):
        await svc._validate_slot(
            "u1",
            ProfileSlot(origin="platform", model="glm-5.2", provider_id=None),
            label="main",
        )


def _prov_row(**kwargs):
    defaults = {
        "id": "prov-1",
        "label": "OpenAI",
        "default_model": "gpt-4o",
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _profile_db_row(**kwargs):
    defaults = {
        "id": "prof-1",
        "name": "combo",
        "kind": "user",
        "main_origin": "byok",
        "main_provider_id": "prov-1",
        "main_model": "gpt-4o",
        "worker_origin": None,
        "worker_provider_id": None,
        "worker_model": None,
        "background_origin": "byok",
        "background_provider_id": "prov-1",
        "background_model": "gpt5.6",
        "vision_origin": None,
        "vision_provider_id": None,
        "vision_model": None,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class _ReachFake:
    def __init__(
        self,
        *,
        model_ids: list[str] | None = None,
        list_error: Exception | None = None,
        fail_models: set[str] | None = None,
    ) -> None:
        self._model_ids = model_ids
        self._list_error = list_error
        self._fail_models = fail_models or set()
        self.probe_models: list[str] = []

    async def list_models(self) -> list[str]:
        if self._list_error is not None:
            raise self._list_error
        assert self._model_ids is not None
        return list(self._model_ids)

    async def probe(self, *, model: str) -> None:
        from agentcore.core.errors import LLMError

        self.probe_models.append(model)
        if model in self._fail_models:
            raise LLMError(f"model {model} not found")

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_create_profile_warns_on_unreachable_byok_model_but_saves():
    from agentcore.llm.credentials import LLMCredentials
    from agentcore.llm.model_profiles import ProfileSlot

    svc = LlmModelProfileService(MagicMock())
    svc._providers = MagicMock()
    svc._providers.get = AsyncMock(return_value=_prov_row())
    svc._users = MagicMock()
    svc._users.set_default_model_profile = AsyncMock()
    created = _profile_db_row()
    svc._repo = MagicMock()
    svc._repo.create = AsyncMock(return_value=created)

    fake = _ReachFake(model_ids=["gpt-4o"], fail_models={"gpt5.6"})
    creds = LLMCredentials(
        api_key="sk", base_url="https://x", default_model="gpt-4o", provider_id="prov-1"
    )
    with (
        patch(
            "agentcore.llm.resolve.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.factory.build_provider", return_value=fake),
    ):
        view = await svc.create_profile(
            "u1",
            name="combo",
            main=ProfileSlot(origin="byok", model="gpt-4o", provider_id="prov-1"),
            background=ProfileSlot(
                origin="byok", model="gpt5.6", provider_id="prov-1"
            ),
        )
    assert view.id == "prof-1"
    assert view.background is not None
    assert view.background.model == "gpt5.6"
    assert len(view.warnings) == 1
    assert "gpt5.6" in view.warnings[0]
    assert "gpt5.6" in fake.probe_models


@pytest.mark.asyncio
async def test_create_profile_ark_ep_not_in_list_no_warning():
    from agentcore.llm.credentials import LLMCredentials
    from agentcore.llm.model_profiles import ProfileSlot

    ep = "ep-20240101000000-abcde"
    svc = LlmModelProfileService(MagicMock())
    svc._providers = MagicMock()
    svc._providers.get = AsyncMock(return_value=_prov_row())
    svc._users = MagicMock()
    created = _profile_db_row(background_model=ep)
    svc._repo = MagicMock()
    svc._repo.create = AsyncMock(return_value=created)

    fake = _ReachFake(model_ids=["gpt-4o", "doubao-pro"], fail_models=set())
    creds = LLMCredentials(
        api_key="sk", base_url="https://ark", default_model="gpt-4o", provider_id="prov-1"
    )
    with (
        patch(
            "agentcore.llm.resolve.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.factory.build_provider", return_value=fake),
    ):
        view = await svc.create_profile(
            "u1",
            name="combo",
            main=ProfileSlot(origin="byok", model="gpt-4o", provider_id="prov-1"),
            background=ProfileSlot(origin="byok", model=ep, provider_id="prov-1"),
        )
    assert view.warnings == ()
    assert ep in fake.probe_models


@pytest.mark.asyncio
async def test_create_profile_list_fetch_failure_saves_without_warning():
    from agentcore.core.errors import LLMError
    from agentcore.llm.credentials import LLMCredentials
    from agentcore.llm.model_profiles import ProfileSlot

    svc = LlmModelProfileService(MagicMock())
    svc._providers = MagicMock()
    svc._providers.get = AsyncMock(return_value=_prov_row())
    svc._users = MagicMock()
    created = _profile_db_row(background_model="gpt5.6")
    svc._repo = MagicMock()
    svc._repo.create = AsyncMock(return_value=created)

    fake = _ReachFake(list_error=LLMError("upstream /models 500"), fail_models={"gpt5.6"})
    creds = LLMCredentials(
        api_key="sk", base_url="https://x", default_model="gpt-4o", provider_id="prov-1"
    )
    with (
        patch(
            "agentcore.llm.resolve.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.factory.build_provider", return_value=fake),
    ):
        view = await svc.create_profile(
            "u1",
            name="combo",
            main=ProfileSlot(origin="byok", model="gpt-4o", provider_id="prov-1"),
            background=ProfileSlot(
                origin="byok", model="gpt5.6", provider_id="prov-1"
            ),
        )
    assert view.id == "prof-1"
    assert view.warnings == ()
    assert fake.probe_models == []
