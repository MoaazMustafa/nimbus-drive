"use client";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  progress: number; // 0..1
  status: "uploading" | "done" | "error";
  error?: string;
}

export function uploadOne(
  dir: string,
  file: File,
  onProgress: (frac: number) => void
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/fs/upload?dir=${encodeURIComponent(dir)}`);
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

/** Upload many files with limited parallelism. */
export async function uploadMany(
  dir: string,
  files: File[],
  update: (id: string, patch: Partial<UploadItem>) => void,
  add: (item: UploadItem) => void,
  onAnyDone: () => void
) {
  const queue = files.map((f) => ({
    file: f,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }));
  for (const q of queue) {
    add({ id: q.id, name: q.file.name, size: q.file.size, progress: 0, status: "uploading" });
  }
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      const res = await uploadOne(dir, next.file, (frac) => update(next.id, { progress: frac }));
      update(next.id, {
        progress: 1,
        status: res.ok ? "done" : "error",
        error: res.error,
      });
      onAnyDone();
    }
  });
  await Promise.all(workers);
}
