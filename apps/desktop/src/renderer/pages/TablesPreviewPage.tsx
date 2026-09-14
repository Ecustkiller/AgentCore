import {
  TableEditor,
  createDemoTable,
  pauseTablesPersist,
  useTablesStore,
} from "@/tables";
import { useEffect, useState } from "react";

/** Offline preview: `#/preview/tables` — no auth, seeded demo table. */
export function TablesPreviewPage() {
  const [ready, setReady] = useState(false);
  const table = useTablesStore((s) => s.tables[0]);

  useEffect(() => {
    const prev = useTablesStore.getState().tables;
    const resume = pauseTablesPersist();
    useTablesStore.setState({ tables: [createDemoTable()] });
    setReady(true);
    return () => {
      useTablesStore.setState({ tables: prev });
      resume();
    };
  }, []);

  if (!ready || !table) return null;
  return (
    <div className="absolute inset-0 bg-background text-foreground">
      <TableEditor table={table} />
    </div>
  );
}
