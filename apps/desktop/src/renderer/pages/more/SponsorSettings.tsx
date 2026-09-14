import { SettingsSection, SettingsStack } from "@/components/settings";
import { Card, PageHeader } from "@/components/ui";
import {
  SPONSOR_POSTERS,
  type SponsorPosterKind,
  type SponsorPosters,
} from "@/lib/sponsorPosters";

const POSTER_LABEL: Record<SponsorPosterKind, string> = {
  wechat: "微信",
  alipay: "支付宝",
};

const POSTER_ORDER: SponsorPosterKind[] = ["wechat", "alipay"];

/**
 * 赞助（/more/sponsor）— 自愿打赏入口。
 *
 * 收款码文件 gitignore，不进公开仓。本次 Vite 构建若目录里有
 * `wechat.png` / `alipay.jpg`，会打进该次桌面 / web / Android 包。
 */
export function SponsorSettings({
  posters = SPONSOR_POSTERS,
}: {
  posters?: SponsorPosters;
} = {}) {
  const shown = POSTER_ORDER.filter((id) => posters[id]);
  return (
    <div>
      <PageHeader title="赞助" />
      <SettingsStack>
        <p className="text-sm text-muted-foreground">
          如果本产品对你有所帮助，欢迎您的慷慨赞助支持创作。
        </p>
        {shown.length > 0 ? (
          <SettingsSection
            title="收款码"
            contentClassName="grid max-w-xl grid-cols-1 gap-4 sm:grid-cols-2"
          >
            {shown.map((id) => (
              <Card key={id} className="overflow-hidden">
                <figure>
                  <img
                    src={posters[id]}
                    alt={`${POSTER_LABEL[id]}收款码`}
                    className="w-full"
                  />
                  <figcaption className="px-3 py-2 text-sm text-muted-foreground">
                    {POSTER_LABEL[id]}
                  </figcaption>
                </figure>
              </Card>
            ))}
          </SettingsSection>
        ) : (
          <p className="text-sm text-muted-foreground">
            这一版没有附上收款码。
          </p>
        )}
      </SettingsStack>
    </div>
  );
}
