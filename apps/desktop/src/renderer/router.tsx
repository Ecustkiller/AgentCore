import { AppShell } from "@/components/layout/AppShell";
import { ConversationPage } from "@/pages/ConversationPage";
import { ExplorePage } from "@/pages/ExplorePage";
import { FilesPage } from "@/pages/FilesPage";
import { MessagesPage } from "@/pages/MessagesPage";
import { MorePage } from "@/pages/MorePage";
import { ToolboxPage } from "@/pages/ToolboxPage";
import { AboutSettings } from "@/pages/more/AboutSettings";
import { AppearanceSettings } from "@/pages/more/AppearanceSettings";
import { GeneralSettings } from "@/pages/more/GeneralSettings";
import { ShortcutsSettings } from "@/pages/more/ShortcutsSettings";
import { createHashRouter } from "react-router-dom";

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <ConversationPage /> },
      { path: "conversations/:id", element: <ConversationPage /> },
      { path: "messages", element: <MessagesPage /> },
      { path: "files", element: <FilesPage /> },
      { path: "toolbox", element: <ToolboxPage /> },
      { path: "explore", element: <ExplorePage /> },
      {
        path: "more",
        element: <MorePage />,
        children: [
          { index: true, element: <GeneralSettings /> },
          { path: "appearance", element: <AppearanceSettings /> },
          { path: "shortcuts", element: <ShortcutsSettings /> },
          { path: "about", element: <AboutSettings /> },
        ],
      },
    ],
  },
]);
