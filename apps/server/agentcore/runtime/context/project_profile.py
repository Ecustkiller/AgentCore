from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.workspace.protocol import WorkspaceBackend


@dataclass(frozen=True)
class ProjectProfile:
    """Best-effort workspace project fingerprint."""

    languages: list[str] = field(default_factory=list)
    frameworks: list[str] = field(default_factory=list)
    package_managers: list[str] = field(default_factory=list)
    monorepo_tool: str | None = None
    vcs: str | None = None
    branch: str | None = None
    test_commands: list[str] = field(default_factory=list)
    build_commands: list[str] = field(default_factory=list)
    agents_md_excerpt: str | None = None


async def detect_project_profile(backend: WorkspaceBackend) -> ProjectProfile:
    """Detect project type from workspace files. Best-effort, never raises."""
    languages: list[str] = []
    frameworks: list[str] = []
    package_managers: list[str] = []
    monorepo_tool: str | None = None
    vcs: str | None = None
    branch: str | None = None
    test_commands: list[str] = []
    build_commands: list[str] = []
    agents_md_excerpt: str | None = None

    try:
        content = await backend.read("pyproject.toml")
        if content:
            languages.append("python")
            if "fastapi" in content.lower():
                frameworks.append("fastapi")
            if "django" in content.lower():
                frameworks.append("django")
            if "[tool.uv]" in content or "uv" in content:
                package_managers.append("uv")
            elif "[tool.poetry]" in content:
                package_managers.append("poetry")
            else:
                package_managers.append("pip")
            if "pytest" in content:
                test_commands.append("pytest")
    except Exception:
        pass

    try:
        await backend.read("requirements.txt")
        if "python" not in languages:
            languages.append("python")
            package_managers.append("pip")
    except Exception:
        pass

    try:
        content = await backend.read("package.json")
        if content:
            if "typescript" not in languages:
                if '"typescript"' in content or "tsconfig" in content:
                    languages.append("typescript")
                else:
                    languages.append("javascript")
            if '"react"' in content:
                frameworks.append("react")
            if '"next"' in content:
                frameworks.append("next.js")
            if '"vue"' in content:
                frameworks.append("vue")
            if '"packageManager"' in content and "pnpm" in content:
                package_managers.append("pnpm")
            elif '"packageManager"' in content and "yarn" in content:
                package_managers.append("yarn")
            else:
                package_managers.append("npm")
            if '"test"' in content:
                test_commands.append("npm test")
            if '"build"' in content:
                build_commands.append("npm run build")
    except Exception:
        pass

    try:
        await backend.read("pnpm-workspace.yaml")
        monorepo_tool = "pnpm workspaces"
    except Exception:
        pass

    try:
        content = await backend.read("turbo.json")
        if content:
            monorepo_tool = "turborepo"
    except Exception:
        pass

    try:
        await backend.read("nx.json")
        monorepo_tool = "nx"
    except Exception:
        pass

    try:
        head_content = await backend.read(".git/HEAD")
        if head_content:
            vcs = "git"
            if head_content.startswith("ref: refs/heads/"):
                branch = head_content.strip().removeprefix("ref: refs/heads/")
    except Exception:
        pass

    for agents_file in ("AGENTS.md", "CLAUDE.md"):
        try:
            content = await backend.read(agents_file)
            if content:
                excerpt = content[:400]
                if len(content) > 400:
                    excerpt += "\n..."
                agents_md_excerpt = excerpt
                break
        except Exception:
            pass

    return ProjectProfile(
        languages=languages,
        frameworks=frameworks,
        package_managers=package_managers,
        monorepo_tool=monorepo_tool,
        vcs=vcs,
        branch=branch,
        test_commands=test_commands,
        build_commands=build_commands,
        agents_md_excerpt=agents_md_excerpt,
    )


def render_project_profile(profile: ProjectProfile) -> str:
    """Render profile as concise text for workspace_context injection. ≤600 chars."""
    if not profile.languages and not profile.vcs:
        return ""

    parts: list[str] = []

    if profile.languages:
        lang_str = ", ".join(profile.languages)
        if profile.monorepo_tool:
            parts.append(f"类型：{lang_str} monorepo（{profile.monorepo_tool}）")
        else:
            parts.append(f"主要语言：{lang_str}")

    if profile.frameworks:
        parts.append(f"框架：{', '.join(profile.frameworks)}")

    if profile.package_managers:
        parts.append(f"包管理：{', '.join(profile.package_managers)}")

    if profile.vcs:
        vcs_str = profile.vcs
        if profile.branch:
            vcs_str += f"（分支 {profile.branch}）"
        parts.append(f"版本控制：{vcs_str}")

    commands = profile.test_commands + profile.build_commands
    if commands:
        parts.append(f"常用命令：{' · '.join(commands)}")

    result = "\n".join(f"- {p}" for p in parts)

    if profile.agents_md_excerpt:
        result += f"\n- 项目约定摘录：\n  > {profile.agents_md_excerpt[:200]}"

    if len(result) > 600:
        result = result[:597] + "..."

    return result
