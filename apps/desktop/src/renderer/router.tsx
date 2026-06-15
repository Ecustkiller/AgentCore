import { AppShell } from "@/components/layout/AppShell";
import { RouteError } from "@/components/layout/RouteError";
import { ConversationPage } from "@/pages/ConversationPage";
import { ConversationsPage } from "@/pages/ConversationsPage";
import { ExplorePage } from "@/pages/ExplorePage";
import { FilesPage } from "@/pages/FilesPage";
import { MessagesPage } from "@/pages/MessagesPage";
import { MorePage } from "@/pages/MorePage";
import { ToolboxPage } from "@/pages/ToolboxPage";
import { AboutSettings } from "@/pages/more/AboutSettings";
import { AppearanceSettings } from "@/pages/more/AppearanceSettings";
import { GeneralSettings } from "@/pages/more/GeneralSettings";
import { MembersSettings } from "@/pages/more/MembersSettings";
import { ModelModeSettings } from "@/pages/more/ModelModeSettings";
import { ModelSettings } from "@/pages/more/ModelSettings";
import { ShortcutsSettings } from "@/pages/more/ShortcutsSettings";
import { TeamMechanism } from "@/pages/more/TeamMechanism";
import { UsageSettings } from "@/pages/more/UsageSettings";
import { AiToolsPage } from "@/pages/toolbox/AiToolsPage";
import { createHashRouter } from "react-router-dom";

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
      { path: "messages", element: <MessagesPage /> },
      { path: "messages/:chatId", element: <MessagesPage /> },
      { path: "files", element: <FilesPage /> },
      { path: "toolbox", element: <ToolboxPage /> },
      { path: "toolbox/ai-tools", element: <AiToolsPage /> },
      { path: "explore", element: <ExplorePage /> },
      {
        path: "more",
        element: <MorePage />,
        children: [
          { index: true, element: <GeneralSettings /> },
          { path: "model", element: <ModelSettings /> },
          { path: "model-modes", element: <ModelModeSettings /> },
          { path: "mechanism", element: <TeamMechanism /> },
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
