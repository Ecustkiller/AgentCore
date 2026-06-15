import { AppShell } from "@/components/layout/AppShell";
import { ConversationPage } from "@/pages/ConversationPage";
import { ExplorePage } from "@/pages/ExplorePage";
import { FilesPage } from "@/pages/FilesPage";
import { MessagesPage } from "@/pages/MessagesPage";
import { MorePage } from "@/pages/MorePage";
import { ToolboxPage } from "@/pages/ToolboxPage";
import { AiToolsPage } from "@/pages/toolbox/AiToolsPage";
import { AboutSettings } from "@/pages/more/AboutSettings";
import { AppearanceSettings } from "@/pages/more/AppearanceSettings";
import { GeneralSettings } from "@/pages/more/GeneralSettings";
import { MembersSettings } from "@/pages/more/MembersSettings";
import { ShortcutsSettings } from "@/pages/more/ShortcutsSettings";
import { UsageSettings } from "@/pages/more/UsageSettings";
import { createHashRouter } from "react-router-dom";

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <ConversationPage /> },
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
