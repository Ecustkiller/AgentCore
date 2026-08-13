import { configure } from "@testing-library/dom";

/**
 * Testing Library waits up to 1s by default. That is plenty for one file in isolation,
 * but the suite runs files in parallel, and the heavier pages (用户详情, 回放) can lose
 * the CPU long enough to blow the budget while the assertion itself would have passed —
 * a red build that says nothing about the code.
 *
 * Raising the ceiling costs nothing in the passing case: `waitFor`/`findBy*` resolve as
 * soon as the condition holds, so the extra headroom is only ever spent on a test that
 * was going to fail anyway.
 */
configure({ asyncUtilTimeout: 5000 });
