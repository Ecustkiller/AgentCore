"""成稿【已核实】证据标签守卫（纯函数，零 I/O）。

两道闸共用一套标签抽取与 ``[系统提示]`` 回炉文案口径（镜像 verify.format_guard_steer）：

1. **结辩白名单闸**（A1）：结辩不得出现本方历轮发言 / 质询作答之外的新【已核实·X】标签
   （白名单与 brief 材料同源，不引入外部证据台账）。
2. **出处软校验闸**（A2，opening / continue / 质询作答成稿）：每个【已核实·X】的出处 X 必须
   能与本方检索语料（当轮/历轮证据笔记、工具取证、共享底料）宽松对应——拦「凭空来源」
   （检索记录中完全无迹可循），不拦写法差异。**宁可漏报不可误杀**。

二次违规策略（O2）：剥离违规【已核实·…】标签（含未闭合残缺形态），降级为【待核实·推断】后放行。
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence

# 完整 / 残缺【已核实】标签均由 extract_verified_tags 统一抽取。
_VERIFIED_TAG_PREFIX = "【已核实·"
_PENDING_INFER = "【待核实·推断】"

# 出处归一化：NFKC（全角→半角）+ casefold 后，只保留汉字 / 字母 / 数字——空白与全部标点
# （·、-、—、/、年月日之外的分隔写法）一律抹平，让「腾讯新闻2026年7月3日报道」与
# 「腾讯新闻 2026-07-03」落到可比的同一字符流上。
_NORM_STRIP_RE = re.compile(r"[^0-9a-z\u4e00-\u9fff]+")
_CJK3_RE = re.compile(r"[\u4e00-\u9fff]{3}")


def extract_verified_tags(text: str) -> set[str]:
    """从正文抽取【已核实·出处】标签（含未闭合残缺片段）。"""
    raw = text or ""
    out: set[str] = set()
    prefix_len = len(_VERIFIED_TAG_PREFIX)
    for m in re.finditer(re.escape(_VERIFIED_TAG_PREFIX), raw):
        start = m.start()
        rest = raw[start + prefix_len :]
        close = rest.find("】")
        if close == -1:
            # 未闭合：截到行尾 / 下一个【 / 文末
            end_rel = len(rest)
            for sep in ("\n", "【"):
                i = rest.find(sep)
                if i != -1:
                    end_rel = min(end_rel, i)
            frag = raw[start : start + prefix_len + end_rel]
            if frag:
                out.add(frag)
        else:
            out.add(raw[start : start + prefix_len + close + 1])
    return out

def novel_verified_tags(speech: str, whitelist: frozenset[str] | set[str]) -> list[str]:
    """结辩成稿中相对白名单的新【已核实·X】标签（稳定排序）。"""
    found = extract_verified_tags(speech)
    return sorted(found - set(whitelist))


def demote_verified_tags(text: str, tags: Sequence[str]) -> str:
    """把违规【已核实·…】（含残缺）替换为【待核实·推断】；按长度降序替换防前缀互吞。"""
    result = text or ""
    for tag in sorted((t for t in tags if t), key=len, reverse=True):
        result = result.replace(tag, _PENDING_INFER)
    return result


def format_closing_evidence_steer(novel_tags: Sequence[str]) -> str:
    """结辩证据标签闸的回炉提示（``[系统提示]`` 口径）。"""
    if not novel_tags:
        return ""
    listed = "、".join(novel_tags)
    return (
        "[系统提示] 交付前核验未通过（系统自动核验，非用户反馈），发现以下问题：\n"
        f"- 结辩出现本场材料白名单之外的新核实标签：{listed}。"
        "结辩【不得引入新的【已核实·出处】标签】——只能沿用你本场历轮发言 / 质询作答里"
        "已经出现过的标签；删掉上述新标签，或改为【待核实·推断】，且不得编造本场未出现的事实。\n"
        "请直接修正正文后再给出最终结辩；不要为此道谢、复述或寒暄，直接改。"
    )


def normalize_evidence_text(text: str) -> str:
    """出处宽松匹配的归一化（见模块头注释）。"""
    return _NORM_STRIP_RE.sub("", unicodedata.normalize("NFKC", text or "").casefold())


def is_source_grounded(source: str, corpus_norm: str) -> bool:
    """出处 X 能否在【已归一化】的检索语料中找到依据——宽松匹配、严格兜底。

    任一命中即过（宁可漏报不可误杀）：
    - 归一化后 ≤3 字符：整体包含（如「年报」）；
    - 否则任一 **4-gram** 片段命中（「腾讯新闻2026年7月3日报道」凭「腾讯新闻」/「2026」过）；
    - 或任一 **纯汉字 3-gram** 命中（容忍「新华社速报」vs 语料只有「新华社」的概括写法）。
    纯符号出处归一化后为空 → 不判、直接放行（格式怪异不误杀）。
    """
    s = normalize_evidence_text(source)
    if not s:
        return True
    if len(s) <= 3:
        return s in corpus_norm
    for i in range(len(s) - 3):
        if s[i : i + 4] in corpus_norm:
            return True
    for i in range(len(s) - 2):
        tri = s[i : i + 3]
        if _CJK3_RE.fullmatch(tri) and tri in corpus_norm:
            return True
    return False


def ungrounded_verified_tags(speech: str, corpus: str) -> list[str]:
    """成稿中出处与检索语料对不上的【已核实·X】标签（稳定排序，便于反馈锚定）。

    未闭合残缺标签一律视为违规（无法解析可靠出处）。
    """
    corpus_norm = normalize_evidence_text(corpus)
    out: list[str] = []
    for tag in sorted(extract_verified_tags(speech)):
        if not tag.endswith("】"):
            out.append(tag)
            continue
        source = tag[len(_VERIFIED_TAG_PREFIX) : -1]
        if not is_source_grounded(source, corpus_norm):
            out.append(tag)
    return out


def format_source_grounding_steer(ungrounded: Sequence[str]) -> str:
    """出处软校验闸的回炉提示（``[系统提示]`` 口径）。"""
    if not ungrounded:
        return ""
    listed = "、".join(ungrounded)
    return (
        "[系统提示] 交付前核验未通过（系统自动核验，非用户反馈），发现以下问题：\n"
        f"- 以下【已核实】标签的出处在你本场检索记录（证据笔记 / 工具取证 / 案件底料）中"
        f"无迹可循：{listed}。【已核实·出处】只能标注你确实检索到、检索记录里出现过的来源"
        "——写法可以概括，但不得凭空杜撰来源名；拿不出检索依据的主张改标【待核实·推断】"
        "或删除该主张。\n"
        "请直接修正正文后再给出最终发言；不要为此道谢、复述或寒暄，直接改。"
    )
