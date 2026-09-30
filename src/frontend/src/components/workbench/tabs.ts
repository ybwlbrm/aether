/**
 * Workbench 的 tab 展示元数据（顺序即展示顺序）。
 *
 * 归到 tab 系统自己的模块：外壳（shell/Workbench.tsx）只负责画 chrome，
 * 「有哪些 tab、各自叫什么、什么图标」是 tab 系统的事实，不该寄生在外壳里。
 */
import { Code2, Eye, FolderOpen, Globe, Terminal } from "lucide-react";

import type { WorkbenchTab } from "../../store/workspace";

export interface WorkbenchTabDef {
  readonly id: WorkbenchTab;
  readonly label: string;
  readonly Icon: typeof Globe;
}

export const WORKBENCH_TABS: ReadonlyArray<WorkbenchTabDef> = [
  { id: "browser", label: "Browser", Icon: Globe },
  { id: "code", label: "Code", Icon: Code2 },
  { id: "files", label: "Files", Icon: FolderOpen },
  { id: "terminal", label: "Terminal", Icon: Terminal },
  { id: "preview", label: "Preview", Icon: Eye },
];
