/**
 * Generates TypeScript types from the backend OpenAPI schema.
 * Run: pnpm generate-types
 */

import { execSync } from "child_process";
import { resolve } from "path";

const OPENAPI_URL = "http://localhost:8000/openapi.json";
const OUTPUT_PATH = resolve(
  __dirname,
  "../../apps/desktop/src/renderer/types/api.generated.ts",
);

console.log("Fetching OpenAPI schema from:", OPENAPI_URL);
console.log("Output path:", OUTPUT_PATH);

execSync(
  `npx openapi-typescript ${OPENAPI_URL} --output ${OUTPUT_PATH}`,
  { stdio: "inherit" },
);

console.log("Type generation complete.");
