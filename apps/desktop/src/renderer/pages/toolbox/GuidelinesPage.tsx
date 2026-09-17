import { CapabilityPage } from "@/components/tools/CapabilityPage";
import { PromptCatalog } from "@/components/tools/PromptCatalog";

/** 工具箱「提示词」：常驻 / 按需两区。出厂工具按开场轴并进两区；连接器在按需。官方 HOW 在按需、只读，卡打「官方」。 */
export function GuidelinesPage() {
  return (
    <CapabilityPage>{(data) => <PromptCatalog data={data} />}</CapabilityPage>
  );
}
