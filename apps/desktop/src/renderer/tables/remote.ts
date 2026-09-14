import { isWebPreview } from "@/lib/preview";
import { notifyError } from "@/lib/toast";
import {
  type TableMutation,
  applyTableOps,
  getTable,
  isTableConflict,
  opsForMutation,
} from "@/services/tables";
import {
  type TableMutationEvent,
  pauseTablesPersist,
  setTablesRemoteHandler,
  useTablesStore,
} from "./store";
import type { TableDoc } from "./types";

async function persistMutation(
  tableId: string,
  mutation: TableMutation,
  table: TableDoc,
): Promise<void> {
  const ops = opsForMutation(mutation);
  if (!ops || ops.length === 0) return;
  const live =
    useTablesStore.getState().tables.find((t) => t.id === tableId) ?? table;
  try {
    const result = await applyTableOps(tableId, ops, {
      schemaBaseline: live.schemaVersion ?? null,
    });
    if (result.table) useTablesStore.getState().replaceTable(result.table);
  } catch (err) {
    if (isTableConflict(err)) {
      try {
        useTablesStore.getState().replaceTable(await getTable(tableId));
      } catch (reloadErr) {
        notifyError(reloadErr, "表格已更新，请刷新");
      }
      return;
    }
    notifyError(err, "保存失败");
    try {
      useTablesStore.getState().replaceTable(await getTable(tableId));
    } catch {
      /* keep the optimistic local row */
    }
  }
}

/** Production editor: persist human edits via `/ops` `confirm=true`; 409 → reload. */
export function installTablesRemote(tableId: string): () => void {
  if (isWebPreview()) return () => {};
  const resume = pauseTablesPersist();
  let chain = Promise.resolve();
  setTablesRemoteHandler((event: TableMutationEvent, table) => {
    if (event.tableId !== tableId) return;
    const mutation = event as TableMutation;
    chain = chain.then(() => persistMutation(tableId, mutation, table));
  });
  return () => {
    setTablesRemoteHandler(null);
    resume();
  };
}
