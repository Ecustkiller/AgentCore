import {
  CollaborationTurnFlow,
  GraphLegend,
  HeroGraph,
  MechanismScenarios,
  RuntimePanorama,
} from "@/components/manual/MechanismContent";
import { BookOpen, Layers, LayoutGrid, PlayCircle, Route } from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Callout, Lead, SectionHeading } from "./primitives";

export function ManualMechanism() {
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const target = searchParams.get("s");
    if (!target) return;
    requestAnimationFrame(() =>
      document
        .getElementById(target)
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }, [searchParams]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Callout variant="info">
        这一章是给好奇的人——想看懂团队在后台到底怎么转。
        <span className="font-medium">不看不影响使用</span>
        ，用着用着想深究了再回来。
      </Callout>

      {/* 1. Hero — watch the team run once */}
      <section className="mb-14 mt-10">
        <SectionHeading
          icon={PlayCircle}
          index={1}
          title="看团队跑一遍"
          id="live"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            先别管符号——下面这张图和你复杂任务里看到的同源，正在
            <span className="font-medium text-foreground">跑一遍</span>
            ：看团队怎么分波开工、调研产出怎么汇入分析、最后由 CEO
            收口落进答案。
          </Lead>
          <HeroGraph />
          <Callout variant="tip">
            节点亮蓝＝执行中、入边走粒子；变绿＝完成。背后半透明的「第 N
            波」泳道，就是团队分轮推进的节奏。
          </Callout>
        </div>
      </section>

      {/* 2. Graph legend */}
      <section className="mb-14">
        <SectionHeading
          icon={BookOpen}
          index={2}
          title="看懂协作图"
          id="legend"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            刚才那张图里的节点、连线、颜色、徽章分别是什么意思？下面一个个给你标清楚。
          </Lead>
          <GraphLegend />
        </div>
      </section>

      {/* 3. Runtime panorama */}
      <section className="mb-14">
        <SectionHeading
          icon={Layers}
          index={3}
          title="运行时全景"
          id="panorama"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            你点发送之后，后台发生了什么？准备 → 执行 →
            收尾，三步走。简单对话直接流式回答，零开销；复杂任务才启动多 Agent
            编排。
          </Lead>
          <RuntimePanorama />
        </div>
      </section>

      {/* 4. Turn flow */}
      <section className="mb-14">
        <SectionHeading icon={Route} index={4} title="协作回合" id="turnflow" />
        <div className="mt-4 space-y-4">
          <Lead>
            从你发一句话，到答案出现在气泡里——中间经历了什么？CEO
            什么时候拉人、成员怎么交接、最后怎么收口。
          </Lead>
          <CollaborationTurnFlow />
        </div>
      </section>

      {/* 5. Mechanism scenarios */}
      <section className="mb-14">
        <SectionHeading
          icon={LayoutGrid}
          index={5}
          title="机制场景"
          id="scenarios"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            下面都是<span className="font-medium text-foreground">真的</span>
            协作图——和你对话里看到的一模一样。并行、串行、辩论、嵌套、热修……各种形态都在。
          </Lead>
          <Callout variant="info">
            不是截图，是实时渲染的真实组件。滚到才加载，随便看。
          </Callout>
          <MechanismScenarios />
        </div>
      </section>
    </div>
  );
}
