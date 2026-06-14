/**
 * 「一次协作」示意图：6 个 worker 分 3 波次，体现并行 / 依赖 / 辩论 / 混合四范式。
 * 场景：一次深度调研。
 * - 波次1·并行：资料检索、数据采集（同序号 = 同波次并行）
 * - 波次2·依赖：数据分析、趋势研判（依赖前一波产物，经调度器注入下游）
 * - 波次3·辩论：方案正 / 方案反（对立子任务，产物回 CEO 裁决）
 * - 共享工作区居中枢纽，6 个 Agent 读写共享上下文（含协商互审，A2A 愿景态）
 * - CEO 综合裁决收尾，汇报给你审阅
 * 实线 = 任务流向（委派 / 注入 / 综合）；虚线 = 协作通信（共享工作区）。纯展示 SVG。
 */
function Node({
  x,
  y,
  w,
  h,
  title,
  sub,
  variant = "default",
  badge,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  variant?: "default" | "hub" | "shared";
  badge?: string;
}) {
  const isHub = variant === "hub";
  const isShared = variant === "shared";
  return (
    <g>
      {isHub && (
        <rect
          x={x - 4}
          y={y - 4}
          width={w + 8}
          height={h + 8}
          rx={16}
          fill="none"
          stroke="var(--primary)"
          strokeOpacity={0.22}
          strokeWidth={2}
        />
      )}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={12}
        fill="var(--card)"
        stroke={isHub || isShared ? "var(--primary)" : "var(--border)"}
        strokeOpacity={isShared ? 0.6 : 1}
        strokeWidth={isHub ? 1.6 : 1}
        strokeDasharray={isShared ? "6 4" : undefined}
      />
      <text
        x={x + w / 2}
        y={sub ? y + h / 2 - 5 : y + h / 2 + 4}
        textAnchor="middle"
        fontSize={14}
        fontWeight={600}
        fill="var(--foreground)"
      >
        {title}
      </text>
      {sub && (
        <text
          x={x + w / 2}
          y={y + h / 2 + 14}
          textAnchor="middle"
          fontSize={11}
          fill="var(--muted-foreground)"
        >
          {sub}
        </text>
      )}
      {badge && (
        <g>
          <circle cx={x} cy={y} r={11} fill="var(--primary)" />
          <text
            x={x}
            y={y + 4}
            textAnchor="middle"
            fontSize={11}
            fontWeight={700}
            fill="var(--primary-foreground)"
          >
            {badge}
          </text>
        </g>
      )}
    </g>
  );
}

function Edge({ d, dashed = false }: { d: string; dashed?: boolean }) {
  return (
    <path
      d={d}
      fill="none"
      stroke={dashed ? "var(--brand-2)" : "var(--primary)"}
      strokeOpacity={dashed ? 0.55 : 0.6}
      strokeWidth={1.6}
      strokeDasharray={dashed ? "5 5" : undefined}
      markerEnd={dashed ? "url(#dot)" : "url(#arrow)"}
      markerStart={dashed ? "url(#dot)" : undefined}
    />
  );
}

function EdgeLabel({ x, y, text }: { x: number; y: number; text: string }) {
  const w = text.length * 13 + 10;
  return (
    <g>
      <rect
        x={x - w / 2}
        y={y - 10}
        width={w}
        height={20}
        rx={6}
        fill="var(--card)"
      />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        fontSize={12}
        fill="var(--muted-foreground)"
      >
        {text}
      </text>
    </g>
  );
}

export default function FlowDiagram() {
  return (
    <svg
      viewBox="0 0 1180 380"
      className="h-auto w-full"
      role="img"
      aria-label="协作流程：你下达目标，CEO 主 Agent 组团并用 delegate 定义依赖；波次1 资料检索与数据采集并行，波次2 数据分析与趋势研判依赖前一波产物，波次3 正反方案辩论，三波次共 6 个 Agent 经共享工作区读写共享上下文、产物经调度器注入下游，最终由 CEO 综合裁决并汇报给你审阅"
      style={{ fontFamily: "inherit" }}
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="var(--primary)" fillOpacity="0.7" />
        </marker>
        <marker
          id="dot"
          viewBox="0 0 6 6"
          refX="3"
          refY="3"
          markerWidth="6"
          markerHeight="6"
        >
          <circle cx="3" cy="3" r="2.2" fill="var(--brand-2)" fillOpacity="0.75" />
        </marker>
      </defs>

      {/* 波次标注 */}
      <text
        x={362}
        y={36}
        textAnchor="middle"
        fontSize={12}
        fill="var(--muted-foreground)"
      >
        波次 1 · 并行
      </text>
      <text
        x={578}
        y={36}
        textAnchor="middle"
        fontSize={12}
        fill="var(--muted-foreground)"
      >
        波次 2 · 依赖
      </text>
      <text
        x={794}
        y={36}
        textAnchor="middle"
        fontSize={12}
        fill="var(--muted-foreground)"
      >
        波次 3 · 辩论
      </text>

      {/* 任务流向（实线 + 箭头） */}
      <Edge d="M98 205 L116 205" />
      <Edge d="M228 190 C 262 150, 272 100, 296 86" />
      <Edge d="M228 220 C 262 270, 272 320, 296 324" />
      <Edge d="M428 84 L512 84" />
      <Edge d="M428 326 L512 326" />
      <Edge d="M644 84 L728 84" />
      <Edge d="M644 326 L728 326" />
      <Edge d="M860 84 C 904 100, 916 150, 944 188" />
      <Edge d="M860 326 C 904 320, 916 270, 944 222" />
      <Edge d="M1056 205 L1080 205" />

      {/* 协作通信（虚线 + 双向点）：各 Agent 读写共享工作区 */}
      <Edge d="M362 110 L362 178" dashed />
      <Edge d="M362 300 L362 234" dashed />
      <Edge d="M578 110 L578 178" dashed />
      <Edge d="M578 300 L578 234" dashed />
      <Edge d="M794 110 L794 178" dashed />
      <Edge d="M794 300 L794 234" dashed />

      {/* 边标签 */}
      <EdgeLabel x={262} y={205} text="委派" />
      <EdgeLabel x={470} y={84} text="注入" />
      <EdgeLabel x={686} y={84} text="注入" />
      <EdgeLabel x={902} y={205} text="综合" />

      {/* 节点 */}
      <Node x={20} y={180} w={78} h={50} title="你" sub="下达目标" />
      <Node
        x={116}
        y={168}
        w={112}
        h={74}
        title="CEO 主 Agent"
        sub="理解 · 组团 · 编排"
        variant="hub"
      />
      <Node x={296} y={58} w={132} h={52} title="资料检索" badge="1" />
      <Node x={296} y={300} w={132} h={52} title="数据采集" badge="1" />
      <Node x={512} y={58} w={132} h={52} title="数据分析" badge="2" />
      <Node x={512} y={300} w={132} h={52} title="趋势研判" badge="2" />
      <Node x={728} y={58} w={132} h={52} title="方案 · 正" badge="3" />
      <Node x={728} y={300} w={132} h={52} title="方案 · 反" badge="3" />
      <Node
        x={296}
        y={178}
        w={564}
        h={56}
        title="共享工作区"
        sub="读写共享上下文 · 协商互审"
        variant="shared"
      />
      <Node
        x={944}
        y={170}
        w={112}
        h={70}
        title="CEO 综合"
        sub="裁决 · 汇报"
        variant="hub"
      />
      <Node x={1080} y={180} w={80} h={50} title="你审阅" sub="决策" />
    </svg>
  );
}
