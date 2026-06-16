import { FilePreviewBody } from "@/components/files/FilePreviewBody";
import type { FilePreviewResult } from "@/lib/fileSource";
import { createLocalRootSource } from "@/services/sources/localRootSource";
import { useFilesStore } from "@/stores/files";
import { AlertCircle, FileText, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; result: FilePreviewResult }
  | { status: "error"; reason: string };

export function FilePreview() {
  const selected = useFilesStore((s) => s.selected);
  // Memoize the source per selection so the read effect doesn't re-fire on every
  // unrelated re-render (a fresh closure each render would loop the fetch).
  const source = useMemo(
    () =>
      selected ? createLocalRootSource(selected.rootId, selected.name) : null,
    [selected],
  );
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (!selected || !source) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    source
      .read(selected.relPath)
      .then((result) => {
        if (!cancelled) setState({ status: "ok", result });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, source]);

  if (!selected) {
    return (
      <Centered>
        <FileText size={28} className="text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">选择文件以预览</p>
      </Centered>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <span className="truncate text-sm font-medium text-foreground">
          {selected.name}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" && (
          <Centered>
            <Loader2 size={22} className="animate-spin text-muted-foreground" />
          </Centered>
        )}
        {state.status === "ok" && (
          <FilePreviewBody result={state.result} name={selected.name} />
        )}
        {state.status === "error" && (
          <Centered>
            <AlertCircle size={26} className="text-destructive/70" />
            <p className="text-sm text-muted-foreground">{state.reason}</p>
          </Centered>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      {children}
    </div>
  );
}
