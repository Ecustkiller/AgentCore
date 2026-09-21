import path from "path";
import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

const DESKTOP_RENDERER = path.resolve(
  process.cwd(),
  "../desktop/src/renderer",
);
const DESKTOP_SHARED = path.resolve(process.cwd(), "../desktop/src/shared");
const PACKAGES = path.resolve(process.cwd(), "../../packages");
const OWN_MODULES = path.resolve(process.cwd(), "node_modules");

Config.overrideWebpackConfig((currentConfiguration) => {
  const withTailwind = enableTailwind(currentConfiguration);
  return {
    ...withTailwind,
    resolve: {
      ...withTailwind.resolve,
      alias: {
        ...(withTailwind.resolve?.alias ?? {}),
        "@": DESKTOP_RENDERER,
        "@shared": DESKTOP_SHARED,
        "@agentcore/contract-types": path.join(
          PACKAGES,
          "contract-types/src/index.ts",
        ),
        "@agentcore/protocol-conformance/projectedTurn": path.join(
          PACKAGES,
          "protocol-conformance/src/projectedTurn.ts",
        ),
        "@agentcore/protocol-conformance$": path.join(
          PACKAGES,
          "protocol-conformance/src/index.ts",
        ),
        "@agentcore/design-tokens": path.join(PACKAGES, "design-tokens"),
        // Force all React/xyflow to resolve from this package's node_modules to
        // prevent context splitting when importing desktop components.
        react: path.resolve(OWN_MODULES, "react"),
        "react-dom": path.resolve(OWN_MODULES, "react-dom"),
        "@xyflow/react": path.resolve(OWN_MODULES, "@xyflow/react"),
      },
    },
  };
});
