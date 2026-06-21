import { PageContainer } from "@/components/layout/PageContainer";
import { CapabilityCatalog } from "@/components/tools/CapabilityCatalog";
import { Button } from "@/components/ui";
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

/** 工具箱「AI 能力」子页：完整的能力图鉴（工具 + 技能 + AI 工作准则，CapabilityCatalog）。 */
export function AiToolsPage() {
  const navigate = useNavigate();

  return (
    <PageContainer width="canvas">
      <Button
        variant="ghost"
        onClick={() => navigate("/toolbox")}
        className="mb-4 h-auto gap-1 px-0 py-0 text-sm text-muted-foreground hover:text-foreground"
        icon={<ChevronLeft size={16} />}
      >
        工具箱
      </Button>

      <h1 className="font-semibold text-foreground text-xl">AI 能力</h1>
      <p className="mt-1 text-muted-foreground text-sm">
        AI 团队能用的工具、能查阅的技能，以及它遵循的工作准则——全部公开可查
      </p>

      <div className="mt-6">
        <CapabilityCatalog />
      </div>
    </PageContainer>
  );
}
