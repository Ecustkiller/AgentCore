import { Badge } from "@/components/ui";
import {
  Bot,
  ListChecks,
  MessageSquarePlus,
  Settings,
  Sparkles,
  Square,
  Unplug,
} from "lucide-react";
import type { ComposerCommand } from "./composerCommands";

function commandIcon(id: ComposerCommand["id"]) {
  switch (id) {
    case "skill":
      return <Sparkles size={14} className="shrink-0 text-muted-foreground" />;
    case "model":
      return <Bot size={14} className="shrink-0 text-muted-foreground" />;
    case "new":
      return (
        <MessageSquarePlus
          size={14}
          className="shrink-0 text-muted-foreground"
        />
      );
    case "tasks":
      return (
        <ListChecks size={14} className="shrink-0 text-muted-foreground" />
      );
    case "mcp":
      return <Unplug size={14} className="shrink-0 text-muted-foreground" />;
    case "settings":
      return <Settings size={14} className="shrink-0 text-muted-foreground" />;
    case "stop":
      return <Square size={13} className="shrink-0 text-muted-foreground" />;
  }
}

export function ComposerCommandMenu({
  commands,
  activeIndex,
  placement,
  onSelect,
  onHover,
}: {
  commands: ComposerCommand[];
  activeIndex: number;
  placement: "above" | "below";
  onSelect: (command: ComposerCommand) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      className={
        placement === "above"
          ? "absolute bottom-full left-0 z-30 mb-2 w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
          : "absolute top-full left-0 z-30 mt-2 w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
      }
      data-testid="composer-command-menu"
    >
      <div className="px-3 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground">
        快捷操作
      </div>
      <ul aria-label="快捷操作" className="max-h-64 py-1">
        {commands.map((command, index) => (
          <li key={command.id}>
            <button
              type="button"
              aria-current={index === activeIndex ? "true" : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(command);
              }}
              onMouseEnter={() => onHover(index)}
              className={`flex h-auto w-full items-center gap-2 px-3 py-2 text-left text-sm font-normal ${
                index === activeIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent"
              }`}
            >
              {commandIcon(command.id)}
              <span className="shrink-0">{command.label}</span>
              {command.status ? (
                <Badge tone={command.status.tone} className="px-1 py-0">
                  {command.status.label}
                </Badge>
              ) : null}
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {command.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
