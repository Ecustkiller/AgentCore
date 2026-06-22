import { Compass, Crown, Rocket } from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bullets,
  Callout,
  CardGrid,
  GoLink,
  InfoCard,
  Lead,
  SectionHeading,
  Steps,
} from "./primitives";

export function ManualIntro() {
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
      {/* Section 1: What */}
      <section className="mb-14">
        <SectionHeading icon={Compass} index={1} title="这是什么" id="what" />
        <div className="mt-4 space-y-4">
          <Lead>
            别的 AI 是一个助手，你得一直盯着它。这里不一样——你带的是一整支 AI
            团队。你说目标，它们自己分工、互审、交付。
          </Lead>
          <Callout variant="tip">
            一句话：
            <span className="font-medium">协作，是更高级的智能。</span>
            一个模型再聪明也有天花板，一支团队没有。
          </Callout>
          <p className="text-sm font-medium text-foreground">你的角色升级了</p>
          <CardGrid cols={3}>
            <InfoCard
              title="在 ChatGPT / Claude"
              desc="你是提示者——来回追问，自己拼结果。"
            />
            <InfoCard
              title="在 Cursor / Codex"
              desc="你是指令者——逐条下达，盯着一个助手干活。"
            />
            <InfoCard
              icon={<Crown size={16} />}
              title="在 AgentCore"
              desc="你是领导者——定目标、审产出、拍板。分工？交给团队。"
              highlight
            />
          </CardGrid>
          <Lead>
            你只对接一位
            CEO——简单问题秒答，复杂任务它自己拉人、排活、汇总，最后把结果交给你。
          </Lead>
        </div>
      </section>

      {/* Section 2: Mindset */}
      <section className="mb-14">
        <SectionHeading
          icon={Crown}
          index={2}
          title="核心心智：你是领导者"
          id="mindset"
        />
        <div className="mt-4 space-y-4">
          <Lead>用好它的秘诀就一个：别把自己当操作员，把自己当老板。</Lead>
          <Bullets
            items={[
              {
                title: "说目标，别说步骤",
                desc: "怎么拆、谁来做、先后顺序——这些交给 CEO 操心。",
              },
              {
                title: "小事秒答，大事才动团队",
                desc: "问个天气不会兴师动众，放心。",
              },
              {
                title: "全程透明，随时插手",
                desc: "协作图实时滚动，觉得跑偏了？一条消息就能纠正。",
              },
            ]}
          />
          <Callout variant="info">
            你只跟 CEO
            对话。它是你的唯一对接人——背后怎么排并行、怎么收口、谁干什么，都是它的事。
          </Callout>
        </div>
      </section>

      {/* Section 3: Quick Start */}
      <section className="mb-14">
        <SectionHeading
          icon={Rocket}
          index={3}
          title="5 分钟上手"
          id="quickstart"
        />
        <div className="mt-4 space-y-4">
          <Lead>四步，从零到看见团队给你交活。</Lead>
          <Steps
            items={[
              {
                title: "填 Key",
                desc: (
                  <>
                    去 <GoLink to="/more/model">设置 · 模型配置</GoLink>
                    ，填你的 API Key，选好模型。
                  </>
                ),
              },
              {
                title: "说目标",
                desc: "新建对话，用大白话描述你想要什么。",
              },
              {
                title: "看它干活",
                desc: "简单问题秒回；复杂任务会弹出协作图，每个人在做什么一目了然。",
              },
              {
                title: "收结果",
                desc: "CEO 把团队产出汇总成一份答案交给你。文件落在工作区。",
              },
            ]}
          />
          <Callout variant="tip">
            第一个任务试试这句：「分三路并行做：A、B、C」——你会看到团队同时开工。
          </Callout>
        </div>
      </section>
    </div>
  );
}
