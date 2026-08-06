/**
 * 本机 Host 能力入口（薄 re-export）。
 *
 * 实现已按 op 域拆到 `./host/`：shell 熔断 / 音频 / 服务重启 / 存储 / 电源 /
 * 网络 / 应用 / 开设置 / ping·info / dispatch·ipc。
 * 本文件保持历史 import 路径稳定（`index.ts` / 单测仍可从这里取公开符号）。
 */

export { runHostOp, registerHostIpc } from "./host";
