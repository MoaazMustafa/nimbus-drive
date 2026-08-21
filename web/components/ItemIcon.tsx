"use client";

import {
  Folder,
  FileText,
  Image as ImageIcon,
  Video,
  Music,
  Archive,
  File,
  Sheet,
  Presentation,
  FileType2,
} from "lucide-react";
import type { Kind } from "@/lib/types";

const MAP: Record<Kind, { Icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  folder: { Icon: Folder, cls: "text-sky-500" },
  image: { Icon: ImageIcon, cls: "text-emerald-500" },
  video: { Icon: Video, cls: "text-rose-500" },
  audio: { Icon: Music, cls: "text-violet-500" },
  pdf: { Icon: FileType2, cls: "text-red-500" },
  text: { Icon: FileText, cls: "text-slate-500" },
  archive: { Icon: Archive, cls: "text-amber-500" },
  doc: { Icon: FileText, cls: "text-blue-500" },
  sheet: { Icon: Sheet, cls: "text-green-600" },
  slides: { Icon: Presentation, cls: "text-orange-500" },
  file: { Icon: File, cls: "text-slate-400" },
};

export function ItemIcon({ kind, className = "size-5" }: { kind: Kind; className?: string }) {
  const { Icon, cls } = MAP[kind] ?? MAP.file;
  return <Icon className={`${className} ${cls} shrink-0`} />;
}
