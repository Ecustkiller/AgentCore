import { useEffect, useState } from "react";

/**
 * True only while the *very first* load of a page is still in flight.
 *
 * Freezing filter controls during a refresh is tempting but wrong: the race guards
 * (`loadGenRef` + `AbortController`) exist precisely so an operator can keep changing
 * the query while a request is in flight, and a debounced text input that goes
 * disabled mid-request loses focus and swallows keystrokes.
 *
 * The obvious shorthand — `loading && rows.length === 0` — is not the same thing. Once
 * a filter narrows the table to zero rows, every subsequent change re-enters that state
 * and locks the controls again, so the operator has to wait out a request for each
 * adjustment exactly when they are trying to widen a too-narrow filter. Track whether a
 * load has ever settled instead. Skeleton-vs-data is a separate question and should
 * keep using the row-count check.
 */
export function useFirstLoad(loading: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!loading) setSettled(true);
  }, [loading]);
  return loading && !settled;
}
