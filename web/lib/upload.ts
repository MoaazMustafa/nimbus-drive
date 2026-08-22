"use client";

import { enc } from "./api";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  progress: number; // 0..1
  status: "uploading" | "done" | "error";
  error?: string;
}

/** One file to upload, plus the sub-folder (relative to the target dir) it belongs in. */
export interface UploadTask {
  file: File;
  relSub: string; // "" for a plain file, "Photos/2024" for a folder upload
}

function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i >= 0 ? relPath.slice(0, i) : "";
}

/** Build upload tasks from an <input> FileList (folder input sets webkitRelativePath). */
export function tasksFromFileList(files: FileList | File[]): UploadTask[] {
  return Array.from(files).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
    return { file, relSub: rel ? dirOf(rel) : "" };
  });
}

/** Recursively read a dropped DataTransfer (handles dropped folders in Chromium/WebKit). */
export async function tasksFromDataTransfer(dt: DataTransfer): Promise<UploadTask[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean) as FileSystemEntry[];

  if (entries.length === 0) {
    // No entry API — fall back to a flat file list.
    return Array.from(dt.files || []).map((file) => ({ file, relSub: "" }));
  }

  const out: UploadTask[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      ).catch(() => null);
      if (file) out.push({ file, relSub: prefix });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      // readEntries returns batches; keep calling until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries((e) => resolve(e), () => resolve([]))
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child, childPrefix);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

export function uploadOne(
  dir: string,
  file: File,
  relSub: string,
  onProgress: (frac: number) => void
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const q = relSub ? `&rel=${enc(relSub)}` : "";
    xhr.open("POST", `/api/fs/upload?dir=${enc(dir)}${q}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(ev.loaded / ev.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300) {
          const failed = (body.files || []).find((f: { ok: boolean }) => !f.ok);
          if (failed) resolve({ ok: false, error: failed.error || "Upload failed" });
          else resolve({ ok: true });
        } else {
          resolve({ ok: false, error: body.error || `Upload failed (${xhr.status})` });
        }
      } catch {
        resolve({ ok: xhr.status < 300, error: xhr.status < 300 ? undefined : "Upload failed" });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: "Network error during upload" });
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/** Upload many tasks with limited parallelism. */
export async function uploadMany(
  dir: string,
  tasks: UploadTask[],
  update: (id: string, patch: Partial<UploadItem>) => void,
  add: (item: UploadItem) => void,
  onAnyDone: () => void
) {
  const queue = tasks.map((t, i) => ({
    ...t,
    id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
  }));
  for (const q of queue) {
    const label = q.relSub ? `${q.relSub}/${q.file.name}` : q.file.name;
    add({ id: q.id, name: label, size: q.file.size, progress: 0, status: "uploading" });
  }
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      const res = await uploadOne(dir, next.file, next.relSub, (frac) => update(next.id, { progress: frac }));
      update(next.id, { progress: 1, status: res.ok ? "done" : "error", error: res.error });
      onAnyDone();
    }
  });
  await Promise.all(workers);
}
