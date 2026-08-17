import { Navigate } from "react-router-dom";

/** 旧 /rules 深链 replace 到 /memory，避免书签 404。 */
export function RulesPage() {
  return <Navigate to="/memory" replace />;
}
