import {
  Activity,
  Brain,
  Hand,
  Network,
  ShieldCheck,
  Target,
  UsersRound,
} from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bullets,
  Callout,
  CardGrid,
  DoDont,
  InfoCard,
  Lead,
  SectionHeading,
} from "./primitives";

export function ManualCollaboration() {
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
      {/* 1. Team collaboration overview */}
      <section className="mb-14">
        <SectionHeading
          icon={Network}
          index={1}
          title="团队协作"
          id="collab-overview"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            核心卖点就这个：复杂任务不是一个 AI 硬扛，而是一群 AI
            分工合作——全程在协作图上看得见。
          </Lead>
          <p className="text-sm font-medium text-foreground">
            什么时候会组团？
          </p>
          <Lead>
            CEO 自己判断。能直接答的就直接答，需要动手做的才拉团队——你不用操心。
          </Lead>
          <p className="text-sm font-medium text-foreground">四种协作姿势</p>
          <CardGrid>
            <InfoCard
              title="并行扇出"
              desc="三件事没依赖？同时跑，最后汇总。"
            />
            <InfoCard
              title="串行流水线"
              desc="调研 → 分析 → 撰写，上游喂下游。"
            />
            <InfoCard
              title="辩论 / 互审"
              desc="正反方各陈观点，CEO 拍板定论。"
            />
            <InfoCard
              title="嵌套小队"
              desc="成员还能再拉小队，大活分层推进。"
            />
          </CardGrid>
        </div>
      </section>

      {/* 2. Briefing — how to give a good task */}
      <section className="mb-14">
        <SectionHeading
          icon={Target}
          index={2}
          title="怎么下任务"
          id="briefing"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            你是老板，最该练的技能就一个——把目标说清楚。说得越准，团队产出越准。
          </Lead>
          <p className="text-sm font-medium text-foreground">
            一个好任务的三件套
          </p>
          <Bullets
            items={[
              {
                title: "目标",
                desc: "你要的是什么结果，一句话说清。",
              },
              {
                title: "约束",
                desc: "边界、口味、不要什么——比如「保持接口不变」「用中文」。",
              },
              {
                title: "期望产出",
                desc: "一段摘要？一个能跑的脚本？几个方案对比？说出形态。",
              },
            ]}
          />
          <DoDont
            good={{
              items: [
                "调研近 7 日成本趋势、定位异常点，产出一段 200 字摘要 + 一张趋势表。",
                "用 TypeScript 重写这个模块，保持现有接口不变，并补单元测试。",
              ],
            }}
            bad={{
              items: ["看看成本。", "优化一下代码。"],
            }}
          />
          <p className="text-sm font-medium text-foreground">
            想要它组团？这样说
          </p>
          <Bullets
            items={[
              {
                title: "要并行",
                desc: "「分三路并行做 A、B、C」——你会看到团队同时开工。",
              },
              {
                title: "要串行",
                desc: "「先调研、再分析、最后撰写」——一环喂下一环。",
              },
              {
                title: "要辩论",
                desc: "「正反两方各论证一遍，再给结论」——互审后裁决。",
              },
            ]}
          />
          <Callout variant="tip">
            不确定怎么拆？只说目标就行，CEO
            会自己判断要不要组团、怎么排。说清「要什么」永远比说清「怎么做」更重要。
          </Callout>
        </div>
      </section>

      {/* 3. Roles */}
      <section className="mb-14">
        <SectionHeading
          icon={UsersRound}
          index={3}
          title="角色分配"
          id="roles"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            没有固定的「代码 Agent」「写作 Agent」——每次任务，CEO 现场分配角色。
          </Lead>
          <Bullets
            items={[
              {
                title: "按需上岗",
                desc: "CEO 看任务需要什么，临时给成员配角色和工具（调研员 / 分析师 / 撰写员…）。",
              },
              {
                title: "为什么不固定？",
                desc: "真实任务跨领域，固定角色僵硬。你是老板，不该操心「这事该派给谁」。",
              },
            ]}
          />
          <Callout variant="info">
            后续规划：保存「我的代码审查流程」为可复用模板，或自定义专属 Agent
            人设。
          </Callout>
        </div>
      </section>

      {/* 4. Progress */}
      <section className="mb-14">
        <SectionHeading
          icon={Activity}
          index={4}
          title="任务进度"
          id="progress"
        />
        <div className="mt-4 space-y-4">
          <Lead>团队干到哪了、谁在忙、有没有卡住——全部实时可见。</Lead>
          <Bullets
            items={[
              { title: "流式输出", desc: "每个成员边想边写，你实时看到。" },
              {
                title: "协作图",
                desc: "一张图看全局：谁在跑、谁等着、谁完成了。",
              },
              {
                title: "用时与工具",
                desc: "每个成员花了多久、调了几次工具，节点上都标着。",
              },
            ]}
          />
          <Callout variant="tip">
            看不懂图上的符号？翻到「看懂协作（选读）」里的图例，逐个给你标清楚。
          </Callout>
        </div>
      </section>

      {/* 5. Checkpoints & approval */}
      <section className="mb-14">
        <SectionHeading
          icon={ShieldCheck}
          index={5}
          title="检查点与审批"
          id="checkpoint"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            遇到关键决定或拿不准的地方，团队不会自作主张——会停下来问你。
          </Lead>
          <p className="text-sm font-medium text-foreground">什么时候会停下</p>
          <Bullets
            items={[
              {
                title: "开场澄清",
                desc: "你的需求能做但还不够明确时，CEO 先给一版「起步计划」+ 几个重点问题，让你补齐再开工。",
              },
              {
                title: "关键岔路",
                desc: "遇到影响全局的 A / B 选择，或不可逆的操作，停下等你拍板。",
              },
              {
                title: "工具授权",
                desc: "需要动用敏感操作时，先征得你同意再执行。",
              },
            ]}
          />
          <p className="text-sm font-medium text-foreground">你能怎么回应</p>
          <Bullets
            items={[
              { title: "继续", desc: "认可，照这个计划往下干。" },
              { title: "调整", desc: "给一段说明，让它换个方向再继续。" },
              { title: "停止", desc: "这条路不对，直接中止本回合。" },
            ]}
          />
          <Callout variant="info">
            某个成员干到一半卡住了，会单独「升级」上来问你——但不会拖住其他还在并行跑的成员。
          </Callout>
          <Callout variant="tip">
            关掉窗口或重启了？停在检查点的任务会被存住，下次回来从断点接着续，不用重来。
          </Callout>
        </div>
      </section>

      {/* 6. Take over mid-task */}
      <section className="mb-14">
        <SectionHeading icon={Hand} index={6} title="中途接管" id="control" />
        <div className="mt-4 space-y-4">
          <Lead>全程你都是老板，随时能插手——不用干等它跑完。</Lead>
          <Bullets
            items={[
              {
                title: "纠偏",
                desc: "觉得跑偏了，直接发一条消息说清楚，团队带着已有进度调整。",
              },
              {
                title: "热修（修订）",
                desc: "产物不满意？说「第 2 章重写得更详细些」，它唤回原成员带记忆改，而不是从零重来。",
              },
              {
                title: "停止",
                desc: "太慢或方向全错，点停止按钮中止当前回合。",
              },
              {
                title: "续跑",
                desc: "被打断或暂停的长任务，下次从断点接着跑，不丢上下文。",
              },
            ]}
          />
          <Callout variant="warning">
            纠偏还是重来？发消息默认是「在现有基础上改」；想彻底换方向，明确说「推翻重来」。
          </Callout>
        </div>
      </section>

      {/* 7. Memory */}
      <section className="mb-14">
        <SectionHeading icon={Brain} index={7} title="记忆" id="memory" />
        <div className="mt-4 space-y-4">
          <Lead>不用每次重新交代背景——团队会记住你是谁、你喜欢什么。</Lead>
          <Bullets
            items={[
              {
                title: "跨对话延续",
                desc: "换个对话也不用重新介绍自己和项目。",
              },
              {
                title: "越用越懂你",
                desc: "用得越多，它越清楚你的口味和习惯。",
              },
            ]}
          />
          <Callout variant="tip">
            想让它记住什么？直接说——「以后回答都用中文」「代码用
            TypeScript」。说一次就够了。
          </Callout>
        </div>
      </section>
    </div>
  );
}
