"""Tests for derived CEO ``<项目清单>`` injection (跨项目找项目)."""

from agentcore.memory.store import CORE_MEMORY_FILE, FileMemoryStore
from agentcore.runtime.context.project_catalog import (
    ProjectCatalogEntry,
    build_project_catalog_entries,
    load_project_catalog,
    render_project_catalog,
)
from agentcore.runtime.resolve.prompt import (
    assemble_system_prompt,
    compose_ceo_chat_prompt,
)
from agentcore.runtime.skills import build_system_skill_registry


def test_render_project_catalog_empty_omits_block():
    assert render_project_catalog([]) == ""
    assert render_project_catalog(()) == ""


def test_render_project_catalog_one_line_per_project():
    text = render_project_catalog(
        [
            ProjectCatalogEntry("f1", "支付网关", "处理 Stripe 回调的结算服务"),
            ProjectCatalogEntry("f2", "空壳", ""),
        ]
    )
    assert text.startswith("<项目清单>")
    assert text.endswith("</项目清单>")
    assert "- 支付网关：处理 Stripe 回调的结算服务" in text
    assert "- 空壳" in text
    assert "- 空壳：" not in text


def test_build_sort_preserved_and_hard_limit_truncates():
    folders = [
        ("a", "最近"),
        ("b", "次近"),
        ("c", "更早"),
        ("d", "最旧"),
    ]
    profiles = {
        "a": "## 关于\n- 支付相关\n",
        "b": "## 关于\n- 博客\n",
        "c": "## 关于\n- 工具\n",
        "d": "## 关于\n- 遗留\n",
    }
    entries = build_project_catalog_entries(folders, profiles, limit=2)
    assert [e.name for e in entries] == ["最近", "次近"]
    assert entries[0].summary == "支付相关"
    assert entries[1].summary == "博客"


def test_build_limit_zero_or_empty_folders():
    assert build_project_catalog_entries([("a", "x")], {"a": "hi"}, limit=0) == []
    assert build_project_catalog_entries([], {}, limit=12) == []


def test_derived_rename_and_profile_update_reflected_immediately():
    """No cache in the pure builder — next assemble sees rename / 画像 edits."""
    folders_v1 = [("f1", "旧名")]
    profiles_v1 = {"f1": "## 关于\n- 旧定位\n"}
    v1 = build_project_catalog_entries(folders_v1, profiles_v1, limit=12)
    assert render_project_catalog(v1) == render_project_catalog(
        [ProjectCatalogEntry("f1", "旧名", "旧定位")]
    )

    folders_v2 = [("f1", "新名")]
    profiles_v2 = {"f1": "## 关于\n- 新定位：支付结算\n"}
    v2 = build_project_catalog_entries(folders_v2, profiles_v2, limit=12)
    text = render_project_catalog(v2)
    assert "新名：新定位：支付结算" in text
    assert "旧名" not in text
    assert "旧定位" not in text


def test_compose_ceo_includes_catalog_outside_rules():
    base = assemble_system_prompt(rules_markdown="## 偏好\n- 用中文\n")
    catalog = [
        ProjectCatalogEntry("f1", "支付网关", "结算服务"),
    ]
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult"},
        project_catalog=catalog,
    )
    assert "<项目清单>" in ceo
    assert "- 支付网关：结算服务" in ceo
    # Always memory stays in <rules>; catalog is a sibling section.
    assert "<rules>" in ceo
    assert "用中文" in ceo
    rules_end = ceo.index("</rules>")
    catalog_start = ceo.index("<项目清单>")
    assert rules_end < catalog_start


def test_compose_ceo_omits_empty_catalog():
    base = assemble_system_prompt()
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate"},
        project_catalog=[],
    )
    assert "<项目清单>" not in ceo


async def test_load_project_catalog_wires_folder_repo_and_profiles(
    tmp_path, monkeypatch
):
    store = FileMemoryStore(tmp_path)
    await store.save(
        "u1",
        CORE_MEMORY_FILE,
        "# 画像\n> note\n\n## 关于\n- 支付结算服务\n",
        scope="fid-pay",
    )
    await store.save(
        "u1",
        CORE_MEMORY_FILE,
        "## 关于\n- 个人博客\n",
        scope="fid-blog",
    )

    class _Folder:
        def __init__(self, fid: str, name: str) -> None:
            self.id = fid
            self.name = name

    class _Repo:
        def __init__(self, session) -> None:  # noqa: ANN001
            self._session = session

        async def list_by_user_recently_active(self, user_id: str, *, limit: int):
            assert user_id == "u1"
            # Already activity-sorted; caller passes the hard cap as ``limit``.
            rows = [
                _Folder("fid-pay", "支付"),
                _Folder("fid-blog", "博客"),
                _Folder("fid-old", "遗留"),
            ]
            return rows[:limit]

    class _CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *args):
            return False

    import agentcore.runtime.context.project_catalog as catalog_mod

    monkeypatch.setattr(catalog_mod, "async_session_factory", lambda: _CM())
    monkeypatch.setattr(catalog_mod, "FolderRepository", _Repo)

    entries = await load_project_catalog(store, "u1", limit=2)
    assert [e.folder_id for e in entries] == ["fid-pay", "fid-blog"]
    assert entries[0].name == "支付"
    assert entries[0].summary == "支付结算服务"
    assert entries[1].summary == "个人博客"
    assert render_project_catalog(entries)
    assert render_project_catalog([]) == ""


async def test_load_project_catalog_no_folders_returns_empty(tmp_path, monkeypatch):
    class _Repo:
        def __init__(self, session) -> None:  # noqa: ANN001
            pass

        async def list_by_user_recently_active(self, user_id: str, *, limit: int):
            return []

    class _CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *args):
            return False

    import agentcore.runtime.context.project_catalog as catalog_mod

    monkeypatch.setattr(catalog_mod, "async_session_factory", lambda: _CM())
    monkeypatch.setattr(catalog_mod, "FolderRepository", _Repo)

    store = FileMemoryStore(tmp_path)
    assert await load_project_catalog(store, "u1") == []
