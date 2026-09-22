"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decide, isReadOnlyLogTimeline } = require("./allow-log-timeline");

const TRACE = "31bb661099e447a9be624f72c0d7a7ff";
const CONV = "15209954-e831-44ed-b1fb-3d2d69434b53";

test("allows the pasted trace command and a follow-up --messages", () => {
  const pasted = `uv run python scripts/log_timeline.py --trace ${TRACE}`;
  const messages = `uv run python scripts/log_timeline.py --messages --trace ${TRACE}`;
  assert.equal(isReadOnlyLogTimeline(pasted), true);
  assert.equal(isReadOnlyLogTimeline(messages), true);
  assert.deepEqual(decide(pasted), { permission: "allow" });
  assert.deepEqual(decide(messages), { permission: "allow" });
});

test("allows a conversation id and export-dir read", () => {
  assert.equal(
    isReadOnlyLogTimeline(`uv run python scripts/log_timeline.py ${CONV}`),
    true,
  );
  assert.equal(
    isReadOnlyLogTimeline(
      "uv run python scripts/log_timeline.py --export-dir ../../logs/prod-export --trace " +
        TRACE,
    ),
    true,
  );
});

test("asks before pack, raw, help, redirects, and chained commands", () => {
  const blocked = [
    `uv run python scripts/log_timeline.py --pack ../../logs/packs/${TRACE} --trace ${TRACE}`,
    `uv run python scripts/log_timeline.py --raw --trace ${TRACE}`,
    `uv run python scripts/log_timeline.py --full --pack x --trace ${TRACE}`,
    "uv run python scripts/log_timeline.py --help",
    `uv run python scripts/log_timeline.py --trace ${TRACE} > $env:TEMP\\out.json`,
    `uv run python scripts/log_timeline.py --trace ${TRACE}; Remove-Item x`,
    `echo scripts/log_timeline.py --trace ${TRACE}`,
  ];
  for (const command of blocked) {
    assert.equal(isReadOnlyLogTimeline(command), false, command);
    assert.deepEqual(decide(command), { permission: "ask" });
  }
});

test("asks when the trace id was padded or truncated", () => {
  assert.equal(
    isReadOnlyLogTimeline(
      "uv run python scripts/log_timeline.py --trace 1fa23694edd942488f5045c4df3fdae",
    ),
    false,
  );
});
