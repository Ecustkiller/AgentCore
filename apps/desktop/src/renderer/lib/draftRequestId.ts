import { useComposerDraftStore } from "@/stores/composer";

/**
 * 建会话幂等键（`client_request_id`）—— **生命周期跟草稿走**。
 *
 * 服务端对同一个键只建一条会话（命中同键返回已存在的那条）。键按草稿键缓存：
 *
 * - 同一份草稿未清空前重复发送 → 复用同一个键。用户「以为没发出去又按一次」（创建
 *   POST 其实已落库、只是响应没回来）不会再建出第二条。
 * - 草稿清空 → 键作废，下次发送现铸。发送成功后 composer 会清空，所以「发送成功后
 *   轮换」由同一条规则覆盖；用户手动抹掉重打的新内容也拿到新键，开新会话不受影响。
 *
 * 唯一的例外是回滚：创建失败时草稿原样还回，得把当时那个键**钉回去**
 * （{@link pinDraftRequestId}），否则重试会铸新键，服务端幂等就白设了。
 *
 * 只在内存里（不进 uiStorage）：重复建会话是「几秒内连按」的形状，跨重启没有复用价值，
 * 反而会让隔天的同一份草稿去认领早已过期的键。表只在发送失败后留键，故有界。
 */
const requestIds = new Map<string, string>();

/** 取该草稿键的幂等键，没有就现铸一个。 */
export function resolveDraftRequestId(key: string): string {
  const existing = requestIds.get(key);
  if (existing) return existing;
  const minted = crypto.randomUUID();
  requestIds.set(key, minted);
  return minted;
}

/** 回滚专用：草稿还回去时把发送那一刻的键钉回来，重试才命中服务端幂等。 */
export function pinDraftRequestId(key: string, requestId: string): void {
  requestIds.set(key, requestId);
}

/**
 * 首发「发送当没发生」拆掉空会话后必须作废该键。
 * ``get_by_client_request_id`` 不过滤 ``deleted_at``，复用旧键会领回已软删的行。
 */
export function forgetDraftRequestId(key: string): void {
  requestIds.delete(key);
}

// 草稿清空即作废：composer store 在草稿空掉时会删除该键（见 `write`），所以「发送成功
// 清空」「用户手动抹掉」「按会话清 UI 状态」三条路径共用这一处轮换。
useComposerDraftStore.subscribe((state, prev) => {
  if (state.drafts === prev.drafts || requestIds.size === 0) return;
  for (const key of [...requestIds.keys()]) {
    if (key in prev.drafts && !(key in state.drafts)) requestIds.delete(key);
  }
});

/** @internal vitest —— 清掉跨用例残留的幂等键。 */
export function __resetDraftRequestIdsForTests(): void {
  requestIds.clear();
}
