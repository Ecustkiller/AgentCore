import {
  type GrantFolderHints,
  pickAndGrantReadonlyFolder,
} from "@/lib/grantReadonlyFolder";
import { fulfillClientToolOnce } from "@/services/clientToolFulfill";
import type { ExternalMountReadonlyRequiredPayload } from "@/types/events";
import type { GrantSessionWellKnown } from "@shared/ipc-contract";

/**
 * Desktop half of the ``external_mount_readonly`` client-tool channel (C1 phase 2).
 *
 * After the server suspends and streams ``external_mount_readonly_required``, we
 * resolve path / well_known+target_name via ``grantSessionReadonlyRoot`` (no
 * picker), POST ``external-grants``, and settle over the unified interaction
 * bridge (kind ``client_tool``). Same ``request_id`` is de-duplicated in-process
 * so attach rehang does not re-mint the session root.
 */
export async function performExternalMountReadonly(
  payload: ExternalMountReadonlyRequiredPayload,
  conversationId: string,
): Promise<void> {
  await fulfillClientToolOnce({
    requestId: payload.request_id,
    conversationId,
    logLabel: "externalMountOps",
    perform: () => runExternalMount(payload, conversationId),
  });
}

type ClientToolResult =
  | {
      ok: true;
      value: {
        root_id: string;
        alias: string;
        label: string;
        display_label?: string;
        namespace: string;
      };
    }
  | {
      ok: false;
      error: { kind: string; detail: string; reason?: string };
    };

const WELL_KNOWN = new Set<GrantSessionWellKnown>([
  "desktop",
  "downloads",
  "documents",
]);

function hintsFromPayload(
  payload: ExternalMountReadonlyRequiredPayload,
): GrantFolderHints | undefined {
  const path =
    typeof payload.path === "string" && payload.path.trim()
      ? payload.path.trim()
      : undefined;
  const wellKnown = WELL_KNOWN.has(payload.well_known as GrantSessionWellKnown)
    ? (payload.well_known as GrantSessionWellKnown)
    : undefined;
  const targetName =
    typeof payload.target_name === "string" && payload.target_name.trim()
      ? payload.target_name.trim()
      : undefined;
  if (!path && !wellKnown && !targetName) return undefined;
  return {
    ...(path ? { path } : {}),
    ...(wellKnown ? { wellKnown } : {}),
    ...(targetName ? { targetName } : {}),
  };
}

async function runExternalMount(
  payload: ExternalMountReadonlyRequiredPayload,
  conversationId: string,
): Promise<ClientToolResult> {
  const result = await pickAndGrantReadonlyFolder(
    conversationId,
    hintsFromPayload(payload),
  );
  if (!result.ok) {
    if (result.reason === "unavailable") {
      return {
        ok: false,
        error: {
          kind: "ExternalMountError",
          detail: "非桌面环境，无法挂载本机目录",
          reason: "unavailable",
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "ExternalMountError",
        detail: result.message,
        // Keep structured grant/IPC reason (not_found / not_directory / …).
        reason: result.reason,
      },
    };
  }
  return {
    ok: true,
    value: {
      root_id: result.root.id,
      alias: result.alias,
      label: result.root.name,
      ...(result.displayLabel ? { display_label: result.displayLabel } : {}),
      namespace: result.namespace,
    },
  };
}
