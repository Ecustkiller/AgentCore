import { SettingsStack } from "@/components/settings";
import { PageHeader } from "@/components/ui";

/**
 * 赞助（/more/sponsor）— 自愿打赏入口。
 *
 * 收款码不进公开仓。维护者本机若要展示，另配本地资源，不随 clone 分发。
 */
export function SponsorSettings() {
  return (
    <div>
      <PageHeader title="赞助" />
      <SettingsStack>
        <p className="text-sm text-muted-foreground">
          谢谢你愿意支持。收款码不随公开仓库分发。
        </p>
      </SettingsStack>
    </div>
  );
}
