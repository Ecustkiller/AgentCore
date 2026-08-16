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
 * 「在哪工作」说明弹窗——只回答用户的三个问题：文件放在哪、改的是哪一份、怎么拿回自己电脑。
 *
 * 文案面向普通用户：入口名与「在哪工作」菜单逐字一致，内部实现词与设计文档术语一律不出现
 * （同名测试守着，防抄设计文档回潮）。菜单没有「我的文件」这一项，弹窗也不把它当入口。
 * 云是推荐默认，本机只作并列说明、不给推荐标。
 */
export function WorkspaceChannelGuideDialog({
  open,
  onOpenChange,
  showLocalTraditional,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 有本机盘（桌面端）才讲「打开本机文件夹」；Web 只讲云。 */
  showLocalTraditional: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>在哪工作：怎么选</DialogTitle>
          <DialogDescription>
            默认把文件放在云上；也可以直接改你电脑上的文件夹。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 pb-2 text-sm text-foreground">
          <section className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-medium text-foreground">
                文件放在云上
              </h3>
              <Badge tone="primary">推荐</Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              你在电脑、手机、网页看到的是同一份。它不会自动同步到你电脑：想在自己电脑上拿到，手动导出到某个文件夹，或者导出
              ZIP。
            </p>
            <dl className="space-y-2">
              <div className="space-y-0.5">
                <dt className="text-xs font-medium text-foreground">
                  快速对话
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  不用先选地方，想到什么直接聊；真要存文件时会自动建一个文件夹，也可以先点「新建文件夹」自己建
                </dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-xs font-medium text-foreground">
                  新建文件夹
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  建一个空文件夹，从头开始
                </dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-xs font-medium text-foreground">
                  从本机导入
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  把你电脑上的文件夹复制一份上来；之后改的是云上这份，电脑里的原件不会跟着变
                </dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-xs font-medium text-foreground">
                  从 Git 克隆
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  把远程仓库拉一份到云上
                </dd>
              </div>
            </dl>
          </section>

          {showLocalTraditional ? (
            <section className="space-y-2 rounded-lg border border-border/60 p-3">
              <h3 className="text-sm font-medium text-foreground">
                打开本机文件夹
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                改的就是你电脑上的那个目录，不用先复制上来，适合东西本来就在电脑上、或者非得用你电脑上那套环境的活。它不是离线模式：模型调用一样要联网，对话记录也仍然存在云上。
              </p>
            </section>
          ) : null}

          <section className="space-y-1.5 px-0.5">
            <h3 className="text-sm font-medium text-foreground">怎么选</h3>
            <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              <li>日常用、想在手机和网页接着看 → 上面四个</li>
              {showLocalTraditional ? (
                <li>
                  东西已经在你电脑上、又要用你电脑上的环境 → 打开本机文件夹
                </li>
              ) : null}
              {showLocalTraditional ? (
                <li>
                  电脑上的文件夹也想换设备接着用 → 从本机导入（可选，不必搬）
                </li>
              ) : null}
            </ul>
          </section>
        </div>

        <DialogFooter className="gap-3 sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground sm:max-w-[18rem]">
            这次选的会记住，下次默认还从这里开始。
          </p>
          <Button type="button" onClick={() => onOpenChange(false)}>
            知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
