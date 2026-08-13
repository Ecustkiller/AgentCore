"""CEO citation hint fragment (FRAGMENT_CITATION)."""

# Appended ONLY to the entry CEO chat agent's prompt. The CEO both retrieves (via
# its own tools) and writes the user-facing reply. Tool results carry turn-ledger
# stable ids (``#rN=url``)；CEO cites those ids (引用即出处 P1 · Q10). Display-layer
# ``[n]`` remapping is frontend-side — do not invent ordinals.
CHAT_CITATION_HINT = """
<citing_sources>
【汇总继承】收尾综述若沿用队员产出中的关键数字 / 关键结论，须一并带上队员原文中的台账 id（#rN），\
或保留其待核实语——禁止抹掉出处后写成既定事实；同一 URL 不得重新编号。\
多条来源共撑一句就一并标注（如 #r1#r2）。台账 #rN 真假核验与成稿举证纪律见共享基座 \
delivery_baseline / claim_evidence；细教法见调研类 skill。
</citing_sources>"""
