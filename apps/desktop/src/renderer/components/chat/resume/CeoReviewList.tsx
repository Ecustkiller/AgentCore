/** Shared CEO risk / suggestion list — cold resume + future hot reuse. */
export function CeoReviewList({
  label,
  items,
}: {
  label: string;
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="first:mt-0">
      <p className="text-xs font-medium text-foreground/80">{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((item) => (
          <li key={item} className="flex gap-1 text-xs text-muted-foreground">
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <span className="min-w-0 whitespace-pre-wrap">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
