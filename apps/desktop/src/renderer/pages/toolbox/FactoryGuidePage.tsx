import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { Navigate, useSearchParams } from "react-router-dom";

/** 旧 /toolbox/guides：?tool= / ?skill= 收到官方读卡，其余收到我的。 */
export function FactoryGuidePage() {
  const [params] = useSearchParams();
  const next = new URLSearchParams();
  const tool = params.get("tool");
  const skill = params.get("skill");
  if (tool) next.set("tool", tool);
  if (skill) next.set("skill", skill);
  const q = next.toString();
  const dest =
    tool || skill ? APP_PATHS.toolbox.official : APP_PATHS.toolbox.mine.skills;
  return <Navigate to={`${dest}${q ? `?${q}` : ""}`} replace />;
}
