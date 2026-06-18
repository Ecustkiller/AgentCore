// `pnpm conformance` entry for the mobile fold (手机端落地设计 §六 支柱3).
// Runs the brand-new mobile fold against the backend-exported golden vectors and
// exits non-zero on any ProjectedTurn drift (CI gate). Desktop will add its own
// conformance script registering its fold-snapshot adapter against the same golden.
import { runConformance } from "@agentcore/protocol-conformance";
import { fold } from "./fold";

const { failed } = runConformance({ name: "mobile", fold });
process.exit(failed === 0 ? 0 : 1);
