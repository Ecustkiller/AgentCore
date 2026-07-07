/** 辩论阶段切换分隔栏：居中标签 + 两侧虚线。 */
export function StageDivider({
  label,
  icon,
  id,
}: {
  label: string;
  icon?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      className="my-3 flex h-9 scroll-mt-28 items-center gap-3"
      aria-label={label}
    >
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="shrink-0 text-xs text-muted-foreground">
        {icon ? <span className="mr-1">{icon}</span> : null}
        <span className="font-medium text-foreground">{label}</span>
      </span>
      <span className="h-px flex-1 border-t border-dashed border-border" />
    </div>
  );
}
