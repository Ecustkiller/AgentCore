/**
 * main/browser 桶出口。
 */

export { registerBrowserIpc } from "./ipc";
export {
  startDesktopBrowserBridge,
  stopDesktopBrowserBridge,
  getDesktopBrowserBridgeInfo,
  getDesktopBrowserBridgeCredentials,
} from "./bridge";
export {
  closeAllLocalBrowserPages,
  closeConversationBrowserPages,
} from "./host";
