"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2 } from "lucide-react";
import { api, enc, formatBytes, parentOf } from "@/lib/api";
import type { Entry } from "@/lib/types";
import { ItemIcon } from "./ItemIcon";

export function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(async () => {
      try {
        const data = await api<{ results: Entry[] }>(`/api/fs/search?q=${enc(q.trim())}`);
        setResults(data.results);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 300);
  }, [q]);

  function pick(e: Entry) {
    setOpen(false);
    setQ("");
    if (e.isDir) {
      router.push(`/?p=${enc(e.path)}`);
    } else {
      router.push(`/?p=${enc(parentOf(e.path))}&preview=${enc(e.name)}`);
    }
  }

  return (
    <div ref={boxRef} className="relative w-full max-w-xl">
      <div className="flex items-center gap-2 rounded-full border border-default bg-surface px-4 py-2 focus-within:border-accent/60">
        {busy ? (
          <Loader2 className="size-4 animate-spin text-muted" />
        ) : (
          <Search className="size-4 text-muted" />
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results && setOpen(true)}
          placeholder="Search your drive…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
        />
      </div>
      {open && results && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-96 overflow-auto rounded-2xl border border-default bg-background p-1.5 shadow-xl">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">No matches</p>
          ) : (
            results.map((e) => (
              <button
                key={e.path}
                onClick={() => pick(e)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-foreground/5"
              >
                <ItemIcon kind={e.kind} className="size-4.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{e.name}</span>
                  <span className="block truncate text-xs text-muted">/{e.path}</span>
                </span>
                {!e.isDir && <span className="text-xs text-muted">{formatBytes(e.size)}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
