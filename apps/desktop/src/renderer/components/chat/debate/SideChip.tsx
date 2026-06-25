import { ModelBadge } from "./ModelBadge";
import { shouldShowModelBadge } from "./model";

/**
 * 立场 / 视角名身份徽章：按身份色 `var(--agent-N)` 着色（14% 底，内联 var，遵 color-tokens
 * 身份色板约定——不进 Tailwind 类、不与状态色竞争）。简报的各方速览、叙事发言格、记分卡共用同
 * 一只 pill → live↔收场、结论↔过程，同一方恒同色同形，可顺色追踪一方的论点链。
 */
export function SideNamePill({
  name,
  colorVar,
}: {
  name: string;
  colorVar: string;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        color: colorVar,
        backgroundColor: `color-mix(in oklch, ${colorVar} 14%, transparent)`,
      }}
    >
      {name}
    </span>
  );
}

/**
 * 一方的统一身份标识 = 身份名 pill + 模型徽章（按需）。模型徽章仅在身份名**不**已含厂商名时才显
 * （{@link shouldShowModelBadge}），消除「原生DeepSeek · DeepSeek」这类重复——名是语义立场时
 * 才把「由哪个模型驱动」作为第二维补出来。简报速览与发言格共用，标识在全页恒定一致。
 */
export function SideIdentity({
  name,
  colorVar,
  model,
}: {
  name: string;
  colorVar: string;
  model: string | null | undefined;
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <SideNamePill name={name} colorVar={colorVar} />
      {shouldShowModelBadge(name, model) && <ModelBadge model={model} />}
    </span>
  );
}
