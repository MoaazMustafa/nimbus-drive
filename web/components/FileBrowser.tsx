"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs, Button, Dropdown, Label, Separator, Spinner, toast } from "@heroui/react";
import {
  CloudUpload,
  Download,
  FolderPlus,
  FolderUp,
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
  X,
  Check,
} from "lucide-react";
import { downloadUrl, downloadZip, enc, formatBytes, formatDate, streamUrl, thumbUrl, triggerDownload } from "@/lib/api";
import { useListing, useLiveFolder } from "@/lib/hooks";
import { uploadMany, tasksFromFileList, tasksFromDataTransfer, type UploadItem } from "@/lib/upload";
import type { Entry } from "@/lib/types";
import { ItemIcon } from "./ItemIcon";
import { DeleteDialog, MoveDialog, NewFolderDialog, RenameDialog } from "./Dialogs";
import { LinkDialog } from "./LinkDialog";
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

/** Small selection checkbox used on tiles and rows. */
function SelectBox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`grid size-5 shrink-0 place-items-center rounded-md border transition-colors ${
        checked
          ? "border-accent bg-accent text-accent-foreground"
          : "border-default bg-background/80 text-transparent hover:border-accent"
      }`}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </button>
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
            <Label>Get link</Label>
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // dialogs
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Entry | null>(null);
  const [moveEntries, setMoveEntries] = useState<Entry[]>([]);
  const [deleteEntries, setDeleteEntries] = useState<Entry[]>([]);
  const [linkTarget, setLinkTarget] = useState<Entry | null>(null);
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

  // clear selection when the folder changes
  useEffect(() => {
    setSelected(new Set());
  }, [path]);

  // drop any selected paths that no longer exist after a refresh
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(entries.map((e) => e.path));
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.path)), [entries, selected]);
  const allSelected = entries.length > 0 && selected.size === entries.length;

  const toggle = useCallback((p: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.size === entries.length ? new Set() : new Set(entries.map((e) => e.path))));
  }, [entries]);

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
    (tasks: { file: File; relSub: string }[]) => {
      if (tasks.length === 0) return;
      uploadMany(
        path,
        tasks,
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
          triggerDownload(downloadUrl(entry.path), entry.name);
          if (entry.isDir) toast.info("Zipping folder — download will start shortly");
          break;
        }
        case "share":
          setLinkTarget(entry);
          break;
        case "rename":
          setRenameTarget(entry);
          break;
        case "move":
          setMoveEntries([entry]);
          break;
        case "delete":
          setDeleteEntries([entry]);
          break;
      }
    },
    [previewables]
  );

  const openEntry = useCallback(
    (entry: Entry) => {
      if (entry.isDir) {
        onNavigate(entry.path);
      } else if (PREVIEWABLE.has(entry.kind)) {
        const idx = previewables.findIndex((e) => e.path === entry.path);
        if (idx >= 0) setPreview({ entries: previewables, index: idx });
      } else {
        onAction("download", entry);
      }
    },
    [onNavigate, previewables, onAction]
  );

  const downloadSelected = useCallback(() => {
    if (selectedEntries.length === 1 && !selectedEntries[0].isDir) {
      triggerDownload(downloadUrl(selectedEntries[0].path), selectedEntries[0].name);
    } else {
      downloadZip(selectedEntries.map((e) => e.path));
      toast.info("Preparing your download…");
    }
  }, [selectedEntries]);

  // drag & drop upload (supports dropped folders)
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const tasks = await tasksFromDataTransfer(e.dataTransfer);
      doUpload(tasks);
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
      {/* Toolbar / selection bar */}
      <div className="sticky top-[57px] z-10 flex flex-wrap items-center gap-2 border-b border-default/60 bg-background/80 px-3 py-2.5 backdrop-blur-md sm:px-6">
        {selected.size === 0 ? (
          <>
            <Breadcrumbs className="min-w-0 flex-1">
              {crumbs.map((c, i) =>
                i === crumbs.length - 1 ? (
                  <Breadcrumbs.Item key={c.path || "root"}>{c.name}</Breadcrumbs.Item>
                ) : (
                  <Breadcrumbs.Item key={c.path || "root"} onPress={() => onNavigate(c.path)}>
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
                <span className="hidden sm:inline">New folder</span>
              </Button>

              <Dropdown>
                <Button variant="primary" size="sm">
                  <Plus className="size-4" />
                  Upload
                </Button>
                <Dropdown.Popover placement="bottom end">
                  <Dropdown.Menu
                    onAction={(key) => {
                      if (key === "files") fileInputRef.current?.click();
                      else if (key === "folder") folderInputRef.current?.click();
                    }}
                  >
                    <Dropdown.Item id="files" textValue="Upload files">
                      <Plus className="size-4" />
                      <Label>Upload files</Label>
                    </Dropdown.Item>
                    <Dropdown.Item id="folder" textValue="Upload folder">
                      <FolderUp className="size-4" />
                      <Label>Upload folder</Label>
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  doUpload(tasksFromFileList(e.target.files || []));
                  e.target.value = "";
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                hidden
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                {...({ webkitdirectory: "", directory: "" } as any)}
                onChange={(e) => {
                  doUpload(tasksFromFileList(e.target.files || []));
                  e.target.value = "";
                }}
              />
            </div>
          </>
        ) : (
          <>
            <Button isIconOnly size="sm" variant="ghost" aria-label="Clear selection" onPress={clearSelection}>
              <X className="size-4" />
            </Button>
            <span className="text-sm font-medium">{selected.size} selected</span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="secondary" size="sm" onPress={downloadSelected}>
                <Download className="size-4" />
                <span className="hidden sm:inline">Download</span>
              </Button>
              <Button variant="secondary" size="sm" onPress={() => setMoveEntries(selectedEntries)}>
                <FolderInput className="size-4" />
                <span className="hidden sm:inline">Move</span>
              </Button>
              <Button variant="danger" size="sm" onPress={() => setDeleteEntries(selectedEntries)}>
                <Trash2 className="size-4" />
                <span className="hidden sm:inline">Delete</span>
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 px-3 pb-24 pt-3 sm:px-6">
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
                Drag files or a folder here, use the Upload button, or paste files straight into the storage
                folder on the server — they&apos;ll appear here automatically.
              </p>
            </div>
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {entries.map((e) => {
              const isSel = selected.has(e.path);
              return (
                <div
                  key={e.path}
                  role="button"
                  tabIndex={0}
                  onClick={() => openEntry(e)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") openEntry(e);
                    if (ev.key === " ") {
                      ev.preventDefault();
                      toggle(e.path);
                    }
                  }}
                  className={`nimbus-tile group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border text-left ${
                    isSel ? "border-accent bg-accent/10" : "border-default bg-surface hover:bg-foreground/5"
                  }`}
                >
                  <div className="relative aspect-[4/3] w-full overflow-hidden border-b border-default/60 bg-background/40">
                    <Thumb entry={e} />
                    <div
                      className={`absolute left-1.5 top-1.5 transition-opacity ${
                        isSel ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                      }`}
                    >
                      <SelectBox checked={isSel} onChange={() => toggle(e.path)} label={`Select ${e.name}`} />
                    </div>
                    <div
                      className="absolute right-1.5 top-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                      onClick={(ev) => ev.stopPropagation()}
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
              );
            })}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-default">
            <div className="hidden grid-cols-[28px_1fr_110px_130px_44px] items-center gap-3 border-b border-default bg-surface px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
              <SelectBox checked={allSelected} onChange={toggleAll} label="Select all" />
              <span>Name</span>
              <span className="text-right">Size</span>
              <span className="text-right">Modified</span>
              <span />
            </div>
            {entries.map((e) => {
              const isSel = selected.has(e.path);
              return (
                <div
                  key={e.path}
                  role="button"
                  tabIndex={0}
                  onClick={() => openEntry(e)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") openEntry(e);
                    if (ev.key === " ") {
                      ev.preventDefault();
                      toggle(e.path);
                    }
                  }}
                  className={`grid cursor-pointer grid-cols-[28px_1fr_44px] items-center gap-3 border-b border-default/60 px-4 py-2.5 last:border-b-0 sm:grid-cols-[28px_1fr_110px_130px_44px] ${
                    isSel ? "bg-accent/10" : "hover:bg-foreground/5"
                  }`}
                >
                  <SelectBox checked={isSel} onChange={() => toggle(e.path)} label={`Select ${e.name}`} />
                  <div className="flex min-w-0 items-center gap-3">
                    <ItemIcon kind={e.kind} className="size-4.5" />
                    <span className="truncate text-sm">{e.name}</span>
                  </div>
                  <span className="hidden text-right text-sm text-muted sm:block">
                    {e.isDir ? "—" : formatBytes(e.size)}
                  </span>
                  <span className="hidden text-right text-sm text-muted sm:block">{formatDate(e.mtime)}</span>
                  <div onClick={(ev) => ev.stopPropagation()}>
                    <ItemMenu entry={e} onAction={onAction} />
                  </div>
                </div>
              );
            })}
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
        isOpen={moveEntries.length > 0}
        onOpenChange={(o) => !o && setMoveEntries([])}
        entries={moveEntries}
        onDone={() => {
          mutate();
          clearSelection();
        }}
      />
      <DeleteDialog
        isOpen={deleteEntries.length > 0}
        onOpenChange={(o) => !o && setDeleteEntries([])}
        entries={deleteEntries}
        onDone={() => {
          mutate();
          clearSelection();
        }}
      />
      <LinkDialog isOpen={!!linkTarget} onOpenChange={(o) => !o && setLinkTarget(null)} entry={linkTarget} />
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
