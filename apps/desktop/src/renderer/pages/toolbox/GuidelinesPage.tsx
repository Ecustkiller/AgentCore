import { CapabilityPage } from "@/components/tools/CapabilityPage";
import { PromptCatalog } from "@/components/tools/PromptCatalog";

/** 工具箱目录：官方与我的共用 PromptCatalog，按路径分栏。 */
export function GuidelinesPage() {
  return (
    <CapabilityPage>{(data) => <PromptCatalog data={data} />}</CapabilityPage>
  );
}
