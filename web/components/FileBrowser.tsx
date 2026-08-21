"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs, Button, Dropdown, Label, Separator, Spinner, toast } from "@heroui/react";
import {
  CloudUpload,
  Download,
  FolderPlus,
  Grid2X2,
  Info,
  Link2,
  List,
  MoreVertical,
  Pencil,
  Plus,
  FolderInput,
  Trash2,
  Eye,
  HardDrive,
} from "lucide-react";
import { downloadUrl, enc, formatBytes, formatDate, streamUrl, thumbUrl } from "@/lib/api";
import { useListing, useLiveFolder } from "@/lib/hooks";
import { uploadMany, type UploadItem } from "@/lib/upload";
import type { Entry } from "@/lib/types";
import { ItemIcon } from "./ItemIcon";
import { DeleteDialog, MoveDialog, NewFolderDialog, RenameDialog } from "./Dialogs";
import { ShareDialog } from "./ShareDialog";
import { PreviewModal, type PreviewTarget } from "./PreviewModal";
import { UploadPanel } from "./UploadPanel";

type ViewMode = "grid" | "list";
const PREVIEWABLE = new Set(["image", "video", "audio", "pdf", "text"]);

function Thumb({ entry, size = 320 }: { entry: Entry; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (entry.kind !== "image" || failed) {
    return (
      <div className="grid h-full w-full place-items-center">
        <ItemIcon kind={entry.kind} className="size-10" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={thumbUrl(entry.path, size)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-full w-full rounded-t-xl object-cover"
    />
  );
}

function ItemMenu({
  entry,
  onAction,
}: {
  entry: Entry;
  onAction: (action: string, entry: Entry) => void;
}) {
  return (
    <Dropdown>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={`Actions for ${entry.name}`}
        className="rounded-full"
      >
        <MoreVertical className="size-4" />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu onAction={(key) => onAction(String(key), entry)}>
          {!entry.isDir && PREVIEWABLE.has(entry.kind) && (
            <Dropdown.Item id="preview" textValue="Preview">
              <Eye className="size-4" />
              <Label>Preview</Label>
            </Dropdown.Item>
          )}
          <Dropdown.Item id="download" textValue="Download">
            <Download className="size-4" />
            <Label>Download{entry.isDir ? " as .zip" : ""}</Label>
          </Dropdown.Item>
          <Dropdown.Item id="share" textValue="Share">
            <Link2 className="size-4" />
            <Label>Share</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item id="rename" textValue="Rename">
            <Pencil className="size-4" />
            <Label>Rename</Label>
          </Dropdown.Item>
          <Dropdown.Item id="move" textValue="Move to…">
            <FolderInput className="size-4" />
            <Label>Move to…</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item id="delete" textValue="Delete" variant="danger">
            <Trash2 className="size-4" />
            <Label>Delete</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

export function FileBrowser({
  path,
  onNavigate,
  initialPreviewName,
  onConsumedPreview,
}: {
  path: string;
  onNavigate: (path: string) => void;
  initialPreviewName?: string | null;
  onConsumedPreview?: () => void;
}) {
  const { data, error, isLoading, mutate } = useListing(path, true);
  const [view, setView] = useState<ViewMode>("grid");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // dialogs
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Entry | null>(null);
  const [moveTarget, setMoveTarget] = useState<Entry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
  const [shareTarget, setShareTarget] = useState<Entry | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  // uploads
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("nimbus_view");
      if (saved === "list" || saved === "grid") setView(saved);
    } catch {
      /* ignore */
    }
  }, []);
  const changeView = (v: ViewMode) => {
    setView(v);
    try {
      window.localStorage.setItem("nimbus_view", v);
    } catch {
      /* ignore */
    }
  };

  useLiveFolder(path, true, () => mutate());

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const previewables = useMemo(() => entries.filter((e) => !e.isDir && PREVIEWABLE.has(e.kind)), [entries]);

  // Open a preview requested via search (?preview=name)
  useEffect(() => {
    if (!initialPreviewName || !data) return;
    const idx = previewables.findIndex((e) => e.name === initialPreviewName);
    if (idx >= 0) setPreview({ entries: previewables, index: idx });
    onConsumedPreview?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPreviewName, data]);

  const crumbs = useMemo(() => {
    const parts = path ? path.split("/") : [];
    return [
      { name: "My Drive", path: "" },
      ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") })),
    ];
  }, [path]);

  const doUpload = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      uploadMany(
        path,
        files,
        (id, patch) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x))),
        (item) => setUploads((u) => [...u, item]),
        () => mutate()
      );
    },
    [path, mutate]
  );

  const onAction = useCallback(
    (action: string, entry: Entry) => {
      switch (action) {
        case "preview": {
          const idx = previewables.findIndex((e) => e.path === entry.path);
          if (idx >= 0) setPreview({ entries: previewables, index: idx });
          break;
        }
        case "download": {
          const a = document.createElement("a");
          a.href = downloadUrl(entry.path);
          a.download = entry.name;
          a.click();
          if (entry.isDir) toast.info("Zipping folder — download will start shortly");
          break;
        }
        case "share":
          setShareTarget(entry);
          break;
        case "rename":
          setRenameTarget(entry);
          break;
        case "move":
          setMoveTarget(entry);
          break;
        case "delete":
          setDeleteTarget(entry);
          break;
      }
    },
    [previewables]
  );

  const openEntry = useCallback(
    (entry: Entry) => {
      if (entry.isDir) {
        onNavigate(entry.path);
        setSelected(null);
      } else if (PREVIEWABLE.has(entry.kind)) {
        const idx = previewables.findIndex((e) => e.path === entry.path);
        if (idx >= 0) setPreview({ entries: previewables, index: idx });
      } else {
        onAction("download", entry);
      }
    },
    [onNavigate, previewables, onAction]
  );

  // drag & drop upload
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files || []);
      doUpload(files);
    },
    [doUpload]
  );

  return (
    <div
      className="relative flex min-h-[calc(100dvh-61px)] flex-col"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          dragDepth.current += 1;
          setDragOver(true);
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-4 sm:px-6">
        <Breadcrumbs className="min-w-0 flex-1">
          {crumbs.map((c, i) =>
            i === crumbs.length - 1 ? (
              <Breadcrumbs.Item key={c.path || "root"}>{c.name}</Breadcrumbs.Item>
            ) : (
              <Breadcrumbs.Item
                key={c.path || "root"}
                onPress={() => onNavigate(c.path)}
              >
                {c.name}
              </Breadcrumbs.Item>
            )
          )}
        </Breadcrumbs>

        <div className="flex items-center gap-1.5">
          <div className="mr-1 flex items-center rounded-full border border-default p-0.5">
            <Button
              isIconOnly
              size="sm"
              variant={view === "grid" ? "secondary" : "ghost"}
              className="rounded-full"
              aria-label="Grid view"
              onPress={() => changeView("grid")}
            >
              <Grid2X2 className="size-4" />
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant={view === "list" ? "secondary" : "ghost"}
              className="rounded-full"
              aria-label="List view"
              onPress={() => changeView("list")}
            >
              <List className="size-4" />
            </Button>
          </div>

          <Button variant="secondary" size="sm" onPress={() => setNewFolderOpen(true)}>
            <FolderPlus className="size-4" />
            New folder
          </Button>
          <Button variant="primary" size="sm" onPress={() => fileInputRef.current?.click()}>
            <Plus className="size-4" />
            Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              doUpload(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-4 pb-10 sm:px-6" onClick={() => setSelected(null)}>
        {isLoading && !data ? (
          <div className="grid place-items-center py-24">
            <Spinner aria-label="Loading" size="lg" />
          </div>
        ) : error ? (
          <div className="grid place-items-center py-24 text-center">
            <div>
              <Info className="mx-auto mb-3 size-8 text-danger" />
              <p className="font-medium">Could not load this folder</p>
              <p className="mt-1 text-sm text-muted">{error.message}</p>
              <Button className="mt-4" variant="secondary" onPress={() => mutate()}>
                Try again
              </Button>
            </div>
          </div>
        ) : entries.length === 0 ? (
          <div className="grid place-items-center py-24 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-accent/10">
                <HardDrive className="size-8 text-accent" />
              </div>
              <p className="text-lg font-medium">This folder is empty</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                Drag files here, use the Upload button, or paste files straight into the storage
                folder on the server — they&apos;ll appear here automatically.
              </p>
            </div>
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {entries.map((e) => (
              <div
                key={e.path}
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setSelected(e.path);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") openEntry(e);
                }}
                onDoubleClick={() => openEntry(e)}
                className={`nimbus-tile group flex flex-col overflow-hidden rounded-xl border text-left ${
                  selected === e.path
                    ? "border-accent bg-accent/10"
                    : "border-default bg-surface hover:bg-foreground/5"
                }`}
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden border-b border-default/60 bg-background/40">
                  <Thumb entry={e} />
                  <div
                    className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(ev) => ev.stopPropagation()}
                    onDoubleClick={(ev) => ev.stopPropagation()}
                  >
                    <ItemMenu entry={e} onAction={onAction} />
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <ItemIcon kind={e.kind} className="size-4" />
                  <span className="truncate text-sm" title={e.name}>
                    {e.name}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-default">
            <div className="hidden grid-cols-[1fr_110px_130px_44px] gap-3 border-b border-default bg-surface px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
              <span>Name</span>
              <span className="text-right">Size</span>
              <span className="text-right">Modified</span>
              <span />
            </div>
            {entries.map((e) => (
              <div
                key={e.path}
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setSelected(e.path);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") openEntry(e);
                }}
                onDoubleClick={() => openEntry(e)}
                className={`grid grid-cols-[1fr_44px] items-center gap-3 border-b border-default/60 px-4 py-2.5 last:border-b-0 sm:grid-cols-[1fr_110px_130px_44px] ${
                  selected === e.path ? "bg-accent/10" : "hover:bg-foreground/5"
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ItemIcon kind={e.kind} className="size-4.5" />
                  <span className="truncate text-sm">{e.name}</span>
                </div>
                <span className="hidden text-right text-sm text-muted sm:block">
                  {e.isDir ? "—" : formatBytes(e.size)}
                </span>
                <span className="hidden text-right text-sm text-muted sm:block">{formatDate(e.mtime)}</span>
                <div onClick={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}>
                  <ItemMenu entry={e} onAction={onAction} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Drop overlay */}
      {dragOver && (
        <div className="nimbus-drop-overlay pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-accent/10">
          <div className="flex flex-col items-center gap-2 text-accent">
            <CloudUpload className="size-10" />
            <p className="font-medium">Drop to upload to /{path || "My Drive"}</p>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <NewFolderDialog isOpen={newFolderOpen} onOpenChange={setNewFolderOpen} dir={path} onDone={() => mutate()} />
      <RenameDialog
        isOpen={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        entry={renameTarget}
        onDone={() => mutate()}
      />
      <MoveDialog
        isOpen={!!moveTarget}
        onOpenChange={(o) => !o && setMoveTarget(null)}
        entry={moveTarget}
        onDone={() => mutate()}
      />
      <DeleteDialog
        isOpen={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        entry={deleteTarget}
        onDone={() => mutate()}
      />
      <ShareDialog isOpen={!!shareTarget} onOpenChange={(o) => !o && setShareTarget(null)} entry={shareTarget} />
      <PreviewModal
        target={preview}
        onClose={() => setPreview(null)}
        onNavigate={(i) => setPreview((p) => (p ? { ...p, index: i } : p))}
        streamFor={(e) => streamUrl(e.path)}
        downloadFor={(e) => downloadUrl(e.path)}
        textFor={(e) => `/api/fs/text?path=${enc(e.path)}`}
      />
      <UploadPanel items={uploads} onClear={() => setUploads([])} />
    </div>
  );
}
