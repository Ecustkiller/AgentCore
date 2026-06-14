import { PageContainer } from "@/components/layout/PageContainer";
import { BuiltinToolCatalog } from "@/components/tools/BuiltinToolCatalog";
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

/** 工具箱「AI 工具」卡片的子页：内置动作工具只读目录（复用 BuiltinToolCatalog）。 */
export function AiToolsPage() {
  const navigate = useNavigate();

  return (
    <PageContainer width="canvas">
      <button
        type="button"
        onClick={() => navigate("/toolbox")}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft size={16} />
        工具箱
      </button>

      <h1 className="text-xl font-semibold text-foreground">AI 工具</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        平台内置工具，所有 Agent 默认可用
      </p>

      <div className="mt-6">
        <BuiltinToolCatalog />
      </div>
    </PageContainer>
  );
}
