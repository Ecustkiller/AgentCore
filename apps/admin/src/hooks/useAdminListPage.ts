import { useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * List page in URL (`?page=N`) so drill-in → back keeps the roster page.
 * page≤1 clears the param; updates use replace to avoid history spam.
 *
 * `setPage` identity is stable: RR's `setSearchParams` changes when the
 * search string changes; putting that unstable setter in filter-reset
 * effect deps would re-fire `setPage(1)` after every page click.
 */
export function useAdminListPage(): [number, (page: number) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = Number(searchParams.get("page"));
  const page = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;

  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;

  const setPage = useCallback((next: number) => {
    setSearchParamsRef.current(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next <= 1) sp.delete("page");
        else sp.set("page", String(next));
        return sp;
      },
      { replace: true },
    );
  }, []);

  return [page, setPage];
}
