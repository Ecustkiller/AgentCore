import { AlertTriangle, Home, RotateCw } from "lucide-react";
import {
  isRouteErrorResponse,
  useNavigate,
  useRouteError,
} from "react-router-dom";

/**
 * App-styled fallback for the root route's `errorElement`. React Router renders
 * this for an unmatched path (404) or any error thrown while rendering/loading a
 * route, replacing its bare-bones default ("Unexpected Application Error · Hey
 * developer 👋"). Keeps the user on a themed surface with a clear way back rather
 * than a dead end. A render error is recovered by navigating home (remounts the
 * tree); the reload button is the hard fallback when state is wedged.
 */
export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const is404 = isRouteErrorResponse(error) && error.status === 404;

  const title = is404 ? "页面不存在" : "出了点问题";
  const detail = is404
    ? "这个地址没有对应的页面。"
    : "应用遇到了意外错误，可以重试或返回对话。";

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle size={24} />
      </div>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Home size={15} />
          回到对话
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-accent"
        >
          <RotateCw size={15} />
          重新加载
        </button>
      </div>
    </div>
  );
}
