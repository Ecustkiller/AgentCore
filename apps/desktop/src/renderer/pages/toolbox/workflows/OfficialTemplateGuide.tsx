/**
 * 官方模板区轻量分流提示（静态文案，不依赖模板 id / API）。
 * 卡片仍按接口返回的 templates 渲染；文案可预留尚未上架的「决策对比」。
 */
export function OfficialTemplateGuide() {
  return (
    <div
      data-testid="official-template-guide"
      className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
    >
      <p>
        选模板先看目标：只要弄懂议题→「多角摸底」；要交落盘报告→「调研报告成文」。
      </p>
      <p className="mt-1">
        要落地页/营销站→「搭建营销站点」；从零做应用→「从零搭应用」。要比多个选项再拍板→「决策对比」（目录有则选用）。
      </p>
    </div>
  );
}
