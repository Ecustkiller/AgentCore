import { Button } from "@/components/ui/Button";
import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Changing this remounts the boundary — pass the route so navigating away recovers. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time crashes in a page so one bad row shape doesn't blank the whole
 * console. Without it, React 18 unmounts the entire tree on an uncaught render error
 * and the operator is left staring at a white window with no way back.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[admin] page crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle size={18} />
        </div>
        <p className="text-sm font-medium text-foreground">这个页面出错了</p>
        <p className="max-w-md break-words text-sm text-muted-foreground">
          {error.message || "渲染时发生未知错误"}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => this.setState({ error: null })}
        >
          重新加载此页
        </Button>
      </div>
    );
  }
}
