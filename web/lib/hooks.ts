"use client";

import { useEffect, useRef } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { fetcher, ApiError, parentOf } from "./api";
import type { Listing, Me, Stats } from "./types";

/** Current user. Redirects to /login when the session is missing/expired. */
export function useMe(redirect = true) {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR<Me>("/api/me", fetcher, {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
  useEffect(() => {
    if (redirect && error instanceof ApiError && error.status === 401) {
      router.replace(`/login`);
    }
  }, [error, redirect, router]);
  return { me: data, error, isLoading, mutate };
}

export function useListing(path: string, enabled: boolean) {
  return useSWR<Listing>(enabled ? `/api/fs/list?path=${encodeURIComponent(path)}` : null, fetcher, {
    keepPreviousData: true,
  });
}

export function useStats(enabled: boolean) {
  return useSWR<Stats>(enabled ? "/api/fs/stats" : null, fetcher, {
    refreshInterval: 120_000,
  });
}

/**
 * Live updates: refresh the current listing when the watcher reports that the
 * folder we're looking at changed (files pasted into the disk folder by hand
 * show up without a manual refresh).
 */
export function useLiveFolder(currentPath: string, enabled: boolean, onChange: () => void) {
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const pathRef = useRef(currentPath);
  pathRef.current = currentPath;

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      es = new EventSource("/api/events");
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "fs" && Array.isArray(data.dirs)) {
            const current = pathRef.current;
            if (
              data.dirs.includes(current) ||
              // a dir was created/removed: its parent is in the list too
              data.dirs.some((d: string) => parentOf(d) === current)
            ) {
              cbRef.current();
            }
          }
        } catch {
          /* ignore malformed events */
        }
      };
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [enabled]);
}
