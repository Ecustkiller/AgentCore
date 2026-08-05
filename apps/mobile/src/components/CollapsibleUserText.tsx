import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * 长用户消息折叠壳——对齐桌面 CollapsibleSpeech：短文原样全展；真溢出才夹高度 +
 * 底部渐隐 +「展开全文 / 收起」。仅测内容高度，不扫意图。
 */
export function CollapsibleUserText({
  contentKey,
  children,
}: {
  /** 内容指纹：变化时重测是否溢出。 */
  contentKey: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // contentKey 是刻意的重测键——正文变化后重新判定是否溢出。
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey drives remeasure
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflow(el.scrollHeight - el.clientHeight > 4);
  }, [contentKey]);

  return (
    <div className="collapsible-user-text">
      <div
        ref={ref}
        className={
          expanded
            ? "collapsible-user-text-body"
            : "collapsible-user-text-body is-clamped"
        }
      >
        {children}
        {!expanded && overflow ? (
          <div className="collapsible-user-text-fade" aria-hidden />
        ) : null}
      </div>
      {overflow ? (
        <button
          type="button"
          className="collapsible-user-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : "展开全文"}
        </button>
      ) : null}
    </div>
  );
}
