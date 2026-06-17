import { AppShell } from "@/components/layout/AppShell";
import { RouteError } from "@/components/layout/RouteError";
import { ConversationPage } from "@/pages/ConversationPage";
import { ConversationsPage } from "@/pages/ConversationsPage";
import { ExplorePage } from "@/pages/ExplorePage";
import { FilesPage } from "@/pages/FilesPage";
import { MessagesPage } from "@/pages/MessagesPage";
import { MorePage } from "@/pages/MorePage";
import { ToolboxPage } from "@/pages/ToolboxPage";
import { WorkspacePage } from "@/pages/WorkspacePage";
import { AboutSettings } from "@/pages/more/AboutSettings";
import { AppearanceSettings } from "@/pages/more/AppearanceSettings";
import { MembersSettings } from "@/pages/more/MembersSettings";
import { ModelSettings } from "@/pages/more/ModelSettings";
import { ShortcutsSettings } from "@/pages/more/ShortcutsSettings";
import { UsageSettings } from "@/pages/more/UsageSettings";
import { AiToolsPage } from "@/pages/toolbox/AiToolsPage";
import { TeamMechanism } from "@/pages/toolbox/TeamMechanism";
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
      { index: true, element: <ConversationPage /> },
      { path: "conversations", element: <ConversationsPage /> },
      { path: "conversations/:id", element: <ConversationPage /> },
      { path: "files", element: <FilesPage /> },
      { path: "folders/:folderId", element: <WorkspacePage /> },
      { path: "messages", element: <MessagesPage /> },
      { path: "messages/:chatId", element: <MessagesPage /> },
      { path: "toolbox", element: <ToolboxPage /> },
      { path: "toolbox/ai-tools", element: <AiToolsPage /> },
      { path: "toolbox/mechanism", element: <TeamMechanism /> },
      { path: "explore", element: <ExplorePage /> },
      {
        path: "more",
        element: <MorePage />,
        children: [
          // Opening 设置 lands on the first page (模型配置); there is no overview.
          { index: true, element: <Navigate to="/more/model" replace /> },
          { path: "model", element: <ModelSettings /> },
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
