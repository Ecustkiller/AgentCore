import { Badge, Button } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 「在哪工作」说明弹窗——对着菜单两问：这次聊哪、本机目录怎么用。
 *
 * 只写菜单名和图标看不出来的后果。入口名与「在哪工作」菜单逐字一致；
 * 内部实现词与设计文档术语一律不出现（同名测试守着，防抄设计文档回潮）。
 * 桌面第一屏并列「本地对话 / 云端对话」（默认本地）；网页/手机只有云端对话。
 */
export function WorkspaceChannelGuideDialog({
  open,
  onOpenChange,
  showLocalTraditional,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 有本机盘（桌面端）才讲本机目录两选；Web 只讲云。 */
  showLocalTraditional: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>在哪工作：怎么选</DialogTitle>
          <DialogDescription className="sr-only">
            {showLocalTraditional
              ? "这次聊哪，以及电脑上的文件夹怎么用。"
              : "这次聊哪。"}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="space-y-3 pb-2 text-sm text-foreground">
            <section className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
              <h3 className="text-sm font-medium text-foreground">这次聊哪</h3>
              {showLocalTraditional ? (
                <>
                  <dl className="space-y-2">
                    <div className="space-y-0.5">
                      <dt className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                        <span>本地对话</span>
                        <Badge tone="primary">推荐</Badge>
                      </dt>
                      <dd className="text-xs leading-relaxed text-muted-foreground">
                        文件和运行在这台电脑。对话仍在云上，不是离线。
                      </dd>
                    </div>
                    <div className="space-y-0.5">
                      <dt className="text-xs font-medium text-foreground">
                        云端对话
                      </dt>
                      <dd className="text-xs leading-relaxed text-muted-foreground">
                        文件和运行在云上，手机和网页也能接着改同一份。
                      </dd>
                    </div>
                  </dl>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    列表里点云图标的接着聊；点硬盘图标的会再问怎么用。
                  </p>
                </>
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  你在电脑、手机、网页看到的是同一份。它不会自动同步到你电脑：想在自己电脑上拿到，手动导出到某个文件夹，或者导出
                  ZIP。
                </p>
              )}
            </section>

            {showLocalTraditional ? (
              <section className="space-y-2 rounded-lg border border-border/60 p-3">
                <h3 className="text-sm font-medium text-foreground">
                  电脑上的文件夹怎么用
                </h3>
                <dl className="space-y-2">
                  <div className="space-y-0.5">
                    <dt className="text-xs font-medium text-foreground">
                      直接改这个文件夹
                    </dt>
                    <dd className="text-xs leading-relaxed text-muted-foreground">
                      改的就是电脑上那份。
                    </dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs font-medium text-foreground">
                      先在云上做，原件先不动
                    </dt>
                    <dd className="text-xs leading-relaxed text-muted-foreground">
                      这一单在云上做；做完再决定写不写回，或在芯片上「留在云上接着用」。
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
