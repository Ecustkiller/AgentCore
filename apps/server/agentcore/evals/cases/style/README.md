# 基座输出句套话消融（观察-only）

用来回答：删「语气自然、专业」和「不套话」会不会让套话开场 / 客套收尾变多。
不裁判「专不专业」。**种子 JSON 入库**（`evals lint --suite style` / CI seed lint 钉这 6 例）；**消融报告 `eval-out/` 不入库**，也不进 `release:gate`。

尺子：`style_lint`（`--style`）。看报告 JSON 的 `style.violation_rates`，不看通过率容差。

## 三臂

| 臂 | 提示词 | 报告 |
|---|---|---|
| arm0 | 现行基座，不动 | `eval-out/style-arm0.json` |
| arm1 | 只删「语气自然、专业」 | `eval-out/style-arm1.json` |
| arm2 | 再删「不套话」，留「直接给结论；不复述用户刚说的话。」 | `eval-out/style-arm2.json` |

先存 arm0，再改 `runtime/resolve/prompt/base.py` 那一句。全程同一模型（失败基线那个；默认档不要用免费档下结论）。

## 怎么跑

```bash
cd apps/server
uv run python -m agentcore.evals lint --suite style
uv run python -m agentcore.evals run style --style --out eval-out/style-arm0.json
```

默认就是 `--checks`（无 LLM 裁判）。用例 JSON 已 `samples: 3`。限流就等，不要换模型重跑。

## 事先拍板

- 开场/收尾率没有单方向变差 → 两处都删，继续下一段。
- **只有收尾率升** → 再议要不要留半句挡收尾；不把「专业」写回去。
- **「专业」那一刀套话率也升** → 当意外，先看题和模型档。
