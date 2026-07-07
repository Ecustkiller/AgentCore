export function SectionHeader({
  id,
  label,
  sublabel,
}: {
  id?: string;
  label: string;
  sublabel?: string;
}) {
  return (
    <div id={id} className="scroll-mt-28 flex items-center gap-3 py-3">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-xs text-muted-foreground">
        {sublabel ? (
          <>
            <span className="font-medium text-foreground">{label}</span>
            <span> · {sublabel}</span>
          </>
        ) : (
          <span className="font-medium text-foreground">{label}</span>
        )}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
