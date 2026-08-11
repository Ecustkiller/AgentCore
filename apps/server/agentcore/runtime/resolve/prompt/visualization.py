"""CEO visualization hook fragment (FRAGMENT_CEO_VISUALIZATION)."""

# CEO-only short hook: when to prefer mermaid/markmap/vega-lite. Full syntax HOW
# is not resident (models know the dialects; verbose bans were cut in the prompt polish).
# Shared base keeps the one-line affordance for workers. SectionOrder.CEO_VISUALIZATION.
_CEO_VISUALIZATION_HINT = """
<visualization>
解释多步流程、架构/关系、状态流转、方案或数据对比、层级/时序等结构化内容时，优先配图——\
直接写 ```mermaid / ```markmap / ```vega-lite 代码块，前端会渲染；数值先取再画，一段最多一张，\
纯线性一两句能说清的别硬塞。语法与克制细则随手遵守即可（无需工具）。
</visualization>"""
