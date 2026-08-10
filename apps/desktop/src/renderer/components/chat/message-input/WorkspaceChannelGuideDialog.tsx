import { Badge, Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 「在哪工作」说明弹窗——对照云协作 vs 本机传统；不复述实现词（sidecar / 过桥）。
 * 布局：云推荐卡 + 本机次级卡 + 决策条；记忆提示落 footer。
 */
export function WorkspaceChannelGuideDialog({
  open,
  onOpenChange,
  showLocalTraditional,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 桌面才有本机传统入口；Web/无本机盘只讲云。 */
  showLocalTraditional: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>在哪工作：怎么选</DialogTitle>
          <DialogDescription>
            先分清两条通道；云协作下的几个入口只是起步方式不同。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 pb-2 text-sm text-foreground">
          <section className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-medium text-foreground">云协作</h3>
              <Badge tone="primary">推荐</Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              文件在云桌，多端同一份；Agent
              改的是云上的副本。要进你电脑上的文件夹，用合回或下载
              ZIP——不会自动双向同步。
            </p>
            <dl className="space-y-2">
              <div className="space-y-0.5">
                <dt className="text-xs font-medium text-foreground">
                  快速对话
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  临时云桌，适合先聊再定项目
                </dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-xs font-medium text-foreground">
                  新建云项目
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  空的云项目
                </dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-xs font-medium text-foreground">
                  导入本机项目到云
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  把本机文件夹快照上传成云项目
                </dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-xs font-medium text-foreground">
                  从 Git 克隆
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  在云上浅克隆远程仓库
                </dd>
              </div>
            </dl>
          </section>

          {showLocalTraditional ? (
            <section className="space-y-2 rounded-lg border border-border/60 p-3">
              <h3 className="text-sm font-medium text-foreground">本机传统</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                菜单里的「打开本机项目」：打开的就是本机文件夹；Agent
                直接改该目录。适合已有大仓、或必须碰本机环境。这不是离线模式：模型调用仍走网络，对话也会回写云端。
              </p>
            </section>
          ) : null}

          <section className="space-y-1.5 px-0.5">
            <h3 className="text-sm font-medium text-foreground">怎么选</h3>
            <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              <li>日常、要多端、不确定 → 云协作</li>
              {showLocalTraditional ? (
                <li>已有大仓、必须摸本机工具链 → 打开本机项目</li>
              ) : null}
              {showLocalTraditional ? (
                <li>
                  工程已在本机、又想改成云权威 →
                  用「导入本机项目到云」（可选，不是必须迁）
                </li>
              ) : null}
            </ul>
          </section>
        </div>

        <DialogFooter className="gap-3 sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground sm:max-w-[18rem]">
            选过的通道会记住，方便下次从同一习惯继续。
          </p>
          <Button type="button" onClick={() => onOpenChange(false)}>
            知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
