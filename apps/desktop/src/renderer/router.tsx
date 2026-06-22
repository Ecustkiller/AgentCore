import { ConversationRoute } from "@/components/chat/ConversationRoute";
import { AppShell } from "@/components/layout/AppShell";
import { RouteError } from "@/components/layout/RouteError";
import { ConversationsPage } from "@/pages/ConversationsPage";
import { ExplorePage } from "@/pages/ExplorePage";
import { FilesPage } from "@/pages/FilesPage";
import { MessagesPage } from "@/pages/MessagesPage";
import { MorePage } from "@/pages/MorePage";
import { PreviewPage } from "@/pages/PreviewPage";
import { ToolboxPage } from "@/pages/ToolboxPage";
import { AboutSettings } from "@/pages/more/AboutSettings";
import { AccountSettings } from "@/pages/more/AccountSettings";
import { AppearanceSettings } from "@/pages/more/AppearanceSettings";
import { MembersSettings } from "@/pages/more/MembersSettings";
import { ModelSettings } from "@/pages/more/ModelSettings";
import { ShortcutsSettings } from "@/pages/more/ShortcutsSettings";
import { UsageSettings } from "@/pages/more/UsageSettings";
import { AiToolsPage } from "@/pages/toolbox/AiToolsPage";
import {
  ManualCollaboration,
  ManualIntro,
  ManualMechanism,
  ManualReference,
  ManualShell,
} from "@/pages/toolbox/manual";
import { Navigate, createHashRouter } from "react-router-dom";

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    // Catches both an unmatched path (404) and any error thrown while rendering a
    // child route, so the user lands on an app-styled page instead of React
    // Router's bare default. Errors bubble to this nearest boundary.
    errorElement: <RouteError />,
    children: [
      {
        element: <ConversationRoute />,
        children: [{ index: true }, { path: "conversations/:id" }],
      },
      { path: "conversations", element: <ConversationsPage /> },
      { path: "files", element: <FilesPage /> },
      { path: "messages", element: <MessagesPage /> },
      { path: "messages/:chatId", element: <MessagesPage /> },
      { path: "toolbox", element: <ToolboxPage /> },
      { path: "toolbox/ai-tools", element: <AiToolsPage /> },
      {
        path: "toolbox/manual",
        element: <ManualShell />,
        children: [
          { index: true, element: <Navigate to="intro" replace /> },
          { path: "intro", element: <ManualIntro /> },
          { path: "collaboration", element: <ManualCollaboration /> },
          { path: "mechanism", element: <ManualMechanism /> },
          { path: "reference", element: <ManualReference /> },
        ],
      },
      { path: "explore", element: <ExplorePage /> },
      // Hidden dev route — not in the nav; reach it by typing #/preview. Replays
      // committed conformance vectors through the real dispatch to eyeball every AI
      // state offline (no backend / LLM). See preview/replay.ts.
      { path: "preview", element: <PreviewPage /> },
      {
        path: "more",
        element: <MorePage />,
        children: [
          // Opening 设置 lands on the first page (模型配置); there is no overview.
          { index: true, element: <Navigate to="/more/model" replace /> },
          { path: "model", element: <ModelSettings /> },
          { path: "account", element: <AccountSettings /> },
          { path: "usage", element: <UsageSettings /> },
          { path: "appearance", element: <AppearanceSettings /> },
          { path: "shortcuts", element: <ShortcutsSettings /> },
          { path: "members", element: <MembersSettings /> },
          { path: "about", element: <AboutSettings /> },
        ],
      },
    ],
  },
]);
