# scripts/archive — 本地实验脚本

一次性探针 / 基准 / 测量脚本归档处。**不进生产门禁**；易腐化，仅维护者本机复跑。

运行（在 `apps/server` 下）：

```bash
uv run python scripts/archive/<script>.py
```

夜跑软探针 `probe_code_execution.py` 仍由 `.github/workflows/evals-nightly.yml` 调用（`continue-on-error`），路径已指向本目录；其余脚本无 CI 硬依赖。

`_tmp_*` 为会话残留诊断草稿，勿当工具链入口。
