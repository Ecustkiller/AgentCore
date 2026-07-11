/** 主持人定场引言：整场开篇的题记，轻于裁判小结横带，与轮次大标题成「引言 → 标题」层次。 */
export function OpeningNote({ text }: { text: string }) {
  return (
    <p className="border-l-2 border-border py-0.5 pl-3 text-sm leading-relaxed text-muted-foreground">
      {text}
    </p>
  );
}
