"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Button, Input, Label, Modal, TextField, toast } from "@heroui/react";
import { ChevronLeft, Folder, FolderPlus, CornerDownRight } from "lucide-react";
import { api, enc, fetcher, parentOf } from "@/lib/api";
import type { Entry, Listing } from "@/lib/types";

export function BaseDialog({
  isOpen,
  onOpenChange,
  title,
  children,
  size = "sm",
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} variant="blur">
      <Modal.Container size={size} placement="center">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
          </Modal.Header>
          {children}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function NewFolderDialog({
  isOpen,
  onOpenChange,
  dir,
  onDone,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  dir: string;
  onDone: () => void;
}) {
  const [name, setName] = useState("Untitled folder");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isOpen) setName("Untitled folder");
  }, [isOpen]);

  async function create() {
    setBusy(true);
    try {
      await api("/api/fs/mkdir", { json: { dir, name } });
      toast.success("Folder created");
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not create folder");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BaseDialog isOpen={isOpen} onOpenChange={onOpenChange} title="New folder">
      <Modal.Body>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create();
          }}
        >
          <TextField autoFocus value={name} onChange={setName} aria-label="Folder name">
            <Input placeholder="Folder name" onFocus={(e) => e.currentTarget.select()} />
          </TextField>
        </form>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" isPending={busy} isDisabled={!name.trim()} onPress={create}>
          Create
        </Button>
      </Modal.Footer>
    </BaseDialog>
  );
}

export function RenameDialog({
  isOpen,
  onOpenChange,
  entry,
  onDone,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  entry: Entry | null;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isOpen && entry) setName(entry.name);
  }, [isOpen, entry]);

  async function rename() {
    if (!entry) return;
    setBusy(true);
    try {
      await api("/api/fs/rename", { json: { path: entry.path, newName: name } });
      toast.success("Renamed");
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not rename");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BaseDialog isOpen={isOpen} onOpenChange={onOpenChange} title={`Rename ${entry?.isDir ? "folder" : "file"}`}>
      <Modal.Body>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) rename();
          }}
        >
          <TextField autoFocus value={name} onChange={setName} aria-label="New name">
            <Input
              onFocus={(e) => {
                const v = e.currentTarget.value;
                const dot = v.lastIndexOf(".");
                e.currentTarget.setSelectionRange(0, entry && !entry.isDir && dot > 0 ? dot : v.length);
              }}
            />
          </TextField>
        </form>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          isPending={busy}
          isDisabled={!name.trim() || name === entry?.name}
          onPress={rename}
        >
          Rename
        </Button>
      </Modal.Footer>
    </BaseDialog>
  );
}

export function DeleteDialog({
  isOpen,
  onOpenChange,
  entry,
  onDone,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  entry: Entry | null;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    if (!entry) return;
    setBusy(true);
    try {
      const res = await api<{ trashed: boolean }>("/api/fs/delete", { json: { paths: [entry.path] } });
      toast.success(res.trashed ? "Moved to trash" : "Deleted");
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BaseDialog isOpen={isOpen} onOpenChange={onOpenChange} title={`Delete "${entry?.name}"?`}>
      <Modal.Body>
        <p className="text-sm text-muted">
          {entry?.isDir
            ? "The folder and everything inside it will be removed from the drive."
            : "The file will be removed from the drive."}{" "}
          It is kept in the server&apos;s trash folder as a safety net, and any share links to it will stop
          working.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="danger" isPending={busy} onPress={doDelete}>
          Delete
        </Button>
      </Modal.Footer>
    </BaseDialog>
  );
}

export function MoveDialog({
  isOpen,
  onOpenChange,
  entry,
  onDone,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  entry: Entry | null;
  onDone: () => void;
}) {
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isOpen && entry) setDir(parentOf(entry.path));
  }, [isOpen, entry]);

  const { data } = useSWR<Listing>(
    isOpen ? `/api/fs/list?path=${enc(dir)}` : null,
    fetcher,
    { keepPreviousData: true }
  );
  const folders = useMemo(
    () => (data?.entries ?? []).filter((e) => e.isDir && e.path !== entry?.path),
    [data, entry]
  );
  const invalid =
    !entry ||
    dir === parentOf(entry.path) ||
    (entry.isDir && (dir === entry.path || dir.startsWith(entry.path + "/")));

  async function move() {
    if (!entry) return;
    setBusy(true);
    try {
      await api("/api/fs/move", { json: { paths: [entry.path], destDir: dir } });
      toast.success(`Moved to /${dir || "My Drive"}`);
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not move");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BaseDialog isOpen={isOpen} onOpenChange={onOpenChange} title={`Move "${entry?.name}"`} size="md">
      <Modal.Body>
        <div className="mb-2 flex items-center gap-2 text-sm">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            isDisabled={!dir}
            onPress={() => setDir(parentOf(dir))}
            aria-label="Up one level"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="truncate font-medium">/{dir || "My Drive"}</span>
        </div>
        <div className="max-h-72 min-h-40 overflow-auto rounded-xl border border-default">
          {folders.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">No subfolders here</p>
          ) : (
            folders.map((f) => (
              <button
                key={f.path}
                onClick={() => setDir(f.path)}
                className="flex w-full items-center gap-3 border-b border-default/60 px-4 py-2.5 text-left text-sm last:border-b-0 hover:bg-foreground/5"
              >
                <Folder className="size-4 text-sky-500" />
                <span className="truncate">{f.name}</span>
                <CornerDownRight className="ml-auto size-3.5 text-muted" />
              </button>
            ))
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" isPending={busy} isDisabled={invalid} onPress={move}>
          Move here
        </Button>
      </Modal.Footer>
    </BaseDialog>
  );
}

export { FolderPlus };
