import { IconButton } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FolderUp, Loader2, Upload } from "lucide-react";
import { useState } from "react";

/**
 * 云盘标准：工具条只留一颗上传图标，菜单里再拆文件 / 文件夹
 * （两种系统选择器互斥，不能合成一个对话框）。
 */
export function UploadMenu({
  uploading,
  onUploadFiles,
  onUploadFolder,
}: {
  uploading: boolean;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <SimpleTooltip label="上传">
        <DropdownMenuTrigger asChild>
          <IconButton
            disabled={uploading}
            aria-label="上传"
            aria-expanded={open}
            aria-haspopup="menu"
          >
            {uploading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
          </IconButton>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onUploadFiles()}>
          <Upload size={14} className="shrink-0" />
          上传文件
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onUploadFolder()}>
          <FolderUp size={14} className="shrink-0" />
          上传文件夹
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
