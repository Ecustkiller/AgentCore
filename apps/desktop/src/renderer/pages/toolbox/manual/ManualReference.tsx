import {
  BookMarked,
  FolderOpen,
  HelpCircle,
  LifeBuoy,
  Lock,
  MessageSquare,
  Settings,
  Wrench,
} from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BoundaryTable,
  Bullets,
  Callout,
  Faq,
  GoLink,
  Lead,
  SectionHeading,
  SettingsTable,
} from "./primitives";

export function ManualReference() {
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

  const previewSection = searchParams.get("s") ?? "top";

  return (
    <div
      className="mx-auto w-full max-w-3xl px-6 py-10"
      data-preview-manual="manual-reference"
      data-preview-section={previewSection}
    >
      {/* 1. Chat */}
      <section className="mb-14">
        <SectionHeading icon={MessageSquare} index={1} title="对话" id="chat" />
        <div className="mt-4 space-y-4">
          <Lead>对话就是你的指挥台——所有事都从这里开始。</Lead>
          <Bullets
            items={[
              {
                title: "说人话就行",
                desc: "用日常语言描述目标，不需要任何特殊格式。",
              },
              {
                title: "富表达",
                desc: "可以贴代码、引用文件、发富文本。",
              },
              {
                title: "历史对话",
                desc: "左侧列表管理所有对话，分组、搜索、随时续聊。",
              },
            ]}
          />
          <Callout variant="tip">
            越具体越好——「目标 + 约束 + 想要什么」说清楚，团队产出就越准。
          </Callout>
        </div>
      </section>

      {/* 2. Tools */}
      <section className="mb-14">
        <SectionHeading icon={Wrench} index={2} title="工具与能力" id="tools" />
        <div className="mt-4 space-y-4">
          <Lead>
            工具是团队的「手」——读文件、查资料、调外部 API，全靠这些。
          </Lead>
          <Bullets
            items={[
              {
                title: "内置工具",
                desc: "平台自带，所有 Agent 开箱即用。",
              },
              {
                title: "创作工具",
                desc: "文档 / 思维导图 / 表格 / 白板 / 幻灯片 / 流程图 / 表单 / 可运行产物。",
              },
              {
                title: "集成 / 连接器",
                desc: "通过 MCP 接入第三方，通过 A2A 连接外部 Agent。",
              },
            ]}
          />
          <Callout variant="tip">
            完整清单在 <GoLink to="/toolbox/tools">工具箱 · 能力图鉴</GoLink>
            ——每个工具能做什么、谁可用，一目了然。
          </Callout>
          <Bullets
            items={[
              {
                title: "读代码与 Git 状态",
                desc: "Agent 可读工作区文件、git status / diff / log，无需你逐次点头。",
              },
              {
                title: "改文件与 Git 写入",
                desc: "写文件、git add / commit / 切分支等会弹出审批——你可以「允许一次」或「本轮内都允许」。",
              },
            ]}
          />
        </div>
      </section>

      {/* 3. Workspace */}
      <section className="mb-14">
        <SectionHeading
          icon={FolderOpen}
          index={3}
          title="工作区与文件"
          id="workspace"
        />
        <div className="mt-4 space-y-4">
          <Lead>
            团队做出来的东西，都落在工作区——你和 AI
            共享的文件空间。没有云/本地开关，模式跟着「文件在哪」自动走。
          </Lead>
          <Bullets
            items={[
              {
                title: "绑本地文件夹",
                desc: "在对话里「打开本地文件夹」，团队直接改你电脑上的真实项目——适合开发内环。",
              },
              {
                title: "不绑 → 云端项目",
                desc: "随手聊或纯云端对话，文件存在服务端；手机、网页也能看同一项目。",
              },
              {
                title: "模式条",
                desc: "对话页顶部的云/本地指示条告诉你当前在哪跑；可随时绑文件夹或切回云端。",
              },
              {
                title: "首次产文件才建项目",
                desc: "刚开的新对话还没有项目文件夹——团队第一次写出文件、你上传附件或绑本地夹时，才自动建一个。",
              },
              {
                title: "文件工作台",
                desc: "在文件页直接看、改、整理产物。",
              },
            ]}
          />
          <Callout variant="tip">
            想让团队基于某个文件干活？对话里直接引用它就行。
          </Callout>
        </div>
      </section>

      {/* 4. Settings */}
      <section className="mb-14">
        <SectionHeading
          icon={Settings}
          index={4}
          title="设置速查"
          id="settings"
        />
        <div className="mt-4 space-y-4">
          <Lead>常用设置入口，点击直达。</Lead>
          <SettingsTable />
        </div>
      </section>

      {/* 5. FAQ */}
      <section className="mb-14">
        <SectionHeading icon={HelpCircle} index={5} title="常见问题" id="faq" />
        <div className="mt-4 space-y-4">
          <Faq
            items={[
              {
                q: "为什么没组团？",
                a: "CEO 觉得直接答更快。想要多人协作，把任务拆开说——比如「先 A 再 B，同时做 C」。",
              },
              {
                q: "怎么强制多人干？",
                a: "明确说「并行」或「分工」，比如「分三路同时做……」。CEO 听懂就会拉团队。",
              },
              {
                q: "跑偏了怎么办？",
                a: "发条消息纠正就行。或者直接点停止按钮中止。",
              },
              {
                q: "中途想改方向？",
                a: "直接说新要求。团队会带着已有上下文热修，不从头来。",
              },
              {
                q: "费用怎么看？",
                a: (
                  <>
                    <GoLink to="/more/usage">设置 · 用量</GoLink>{" "}
                    里看花费和额度。
                  </>
                ),
              },
              {
                q: "怎么给产品提意见？",
                a: (
                  <>
                    去 <GoLink to="/more/feedback">设置 · 反馈</GoLink>
                    ，选分类、写标题和描述即可。我们会附带当前页面路由（方便定位你在哪），不含工作区里的文件内容。
                  </>
                ),
              },
              {
                q: "Agent 对 Git / 代码能做什么？",
                a: (
                  <>
                    <p>三类边界，和审批弹窗一致：</p>
                    <BoundaryTable
                      rows={[
                        {
                          can: "读文件；git status / diff / log",
                          approve:
                            "改文件；git add / commit / 建分支 / 切分支；跑代码",
                          wont: "push（含 force push）；reset / rebase；在 main / master 上直接提交",
                        },
                      ]}
                    />
                    <p className="mt-2">
                      推送远端请你在本地终端手动完成——团队只帮你改到可提交的状态。
                    </p>
                  </>
                ),
              },
              {
                q: "用的什么模型？",
                a: (
                  <>
                    DeepSeek V4（快速档 + 强力档）。你在{" "}
                    <GoLink to="/more/model">模型配置</GoLink> 里填自己的 Key。
                  </>
                ),
              },
              {
                q: "数据存哪？",
                a: "文件在工作区，对话记录在后端。文件页随时看、随时导出。",
              },
              {
                q: "想了解底层怎么跑的？",
                a: "看「看懂协作（选读）」这一章：先看团队跑一遍（活图），再到图例、运行时全景、协作回合、机制场景——全有。",
              },
            ]}
          />
        </div>
      </section>

      {/* 6. Troubleshooting */}
      <section className="mb-14">
        <SectionHeading
          icon={LifeBuoy}
          index={6}
          title="故障排查"
          id="troubleshooting"
        />
        <div className="mt-4 space-y-4">
          <Lead>卡住了？对症看这里。</Lead>
          <Faq
            items={[
              {
                q: "填了 Key 还是报错 / 用不了",
                a: (
                  <>
                    去 <GoLink to="/more/model">设置 · 模型配置</GoLink> 核对
                    Key 是否填对、是否选了模型；强力档 / 快速档换一个再试。
                  </>
                ),
              },
              {
                q: "任务一直转、半天不动",
                a: "可能卡在某个成员或外部工具。点停止中止本回合，或发消息追问；长任务也能中途打断、下次从断点续跑。",
              },
              {
                q: "产物找不到 / 没生成文件",
                a: "去文件页的工作区看——Agent 创建、修改的文件都落在那里。",
              },
              {
                q: "费用涨得比预期快",
                a: (
                  <>
                    复杂任务 = 多成员 + 强力档 + 深度思考，成本更高。在{" "}
                    <GoLink to="/more/usage">设置 · 用量</GoLink>{" "}
                    看明细，必要时少用强力档 / 深度。
                  </>
                ),
              },
            ]}
          />
        </div>
      </section>

      {/* 7. Privacy */}
      <section className="mb-14">
        <SectionHeading icon={Lock} index={7} title="数据与隐私" id="privacy" />
        <div className="mt-4 space-y-4">
          <Lead>你的东西存在哪、怎么用——讲清楚。</Lead>
          <Bullets
            items={[
              {
                title: "自带 Key（BYOK）",
                desc: "模型调用用你自己的 API Key，在「设置 · 模型配置」里填写与管理。",
              },
              {
                title: "生成的文件",
                desc: "都在工作区，你可在文件页随时查看、编辑、导出。",
              },
              {
                title: "对话记录",
                desc: "保存在后端，用于续聊与记忆；随时可查。",
              },
              {
                title: "记忆",
                desc: "团队记住的偏好来自你的对话；想改写或清掉，直接说即可。",
              },
              {
                title: "反馈附带的上下文",
                desc: "提交反馈时会自动带上当前页面路由（如所在对话），便于复现问题；不含工作区文件内容。",
              },
            ]}
          />
          <Callout variant="info">
            想带走数据？文件页可导出工作区里的产物。
          </Callout>
        </div>
      </section>

      {/* 8. Glossary */}
      <section className="mb-14">
        <SectionHeading
          icon={BookMarked}
          index={8}
          title="术语"
          id="glossary"
        />
        <div className="mt-4 space-y-4">
          <Lead>手册里常出现的几个词，一句话一个。</Lead>
          <Faq
            items={[
              {
                q: "CEO",
                a: "你唯一对接的主 Agent——既跟你对话，又负责拉团队、排活、汇总。",
              },
              {
                q: "成员 / worker",
                a: "CEO 临时拉来干某个子任务的 Agent，干完即走。",
              },
              {
                q: "协作图",
                a: "把这次任务的分工、依赖、进度画成的一张实时图。",
              },
              {
                q: "检查点",
                a: "团队停下来等你拍板的地方（关键决定或授权）。",
              },
              {
                q: "修订",
                a: "在原产物上带记忆改出的新版本，不是新成员。",
              },
              {
                q: "工作区",
                a: "你和团队共享的文件空间，产物都落在这里。",
              },
              {
                q: "BYOK",
                a: "自带 Key——用你自己的 API Key 调模型。",
              },
            ]}
          />
        </div>
      </section>
    </div>
  );
}
