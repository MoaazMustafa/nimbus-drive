"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { Avatar, Button, Dropdown, Label, Tooltip } from "@heroui/react";
import {
  Cloud,
  HardDrive,
  Link2,
  Trash2,
  ShieldCheck,
  Sun,
  Moon,
  LogOut,
  Menu as MenuIcon,
  Download,
} from "lucide-react";
import { api, enc, formatBytes } from "@/lib/api";
import { useLibraries, useMe, useStats } from "@/lib/hooks";
import type { Library } from "@/lib/types";
import { SearchBox } from "./SearchBox";

const NAV = [
  { href: "/", label: "My Drive", icon: HardDrive },
  { href: "/links", label: "Links", icon: Link2 },
  { href: "/trash", label: "Trash", icon: Trash2 },
  { href: "/admin", label: "Admin", icon: ShieldCheck, adminOnly: true },
];

const navLinkClass = (active: boolean) =>
  `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
    active ? "bg-accent/15 text-accent" : "text-muted hover:bg-foreground/5 hover:text-foreground"
  }`;

/**
 * One row per attached folder. Lives in its own component because it reads the
 * current ?p= to know which folder you are inside, and useSearchParams needs a
 * Suspense boundary of its own — putting it here keeps every page that renders
 * AppShell free of that requirement.
 */
function LibraryList({
  libraries,
  onNavigate,
}: {
  libraries: Library[];
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = pathname === "/" ? (params.get("p") ?? "") : "";
  const activeId = current.split("/")[0];

  return (
    <div className="mt-3">
      <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted/80">
        Folders
      </p>
      <nav className="flex flex-col gap-1">
        {libraries.map((lib) => (
          <Link
            key={lib.id}
            href={`/?p=${enc(lib.id)}`}
            onClick={onNavigate}
            title={lib.available ? lib.root : `${lib.root} — not available right now`}
            className={navLinkClass(activeId === lib.id)}
          >
            <HardDrive className={`size-4.5 shrink-0 ${lib.available ? "" : "opacity-40"}`} />
            <span className="truncate">{lib.name}</span>
            {!lib.available && (
              <span className="ml-auto shrink-0 rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                away
              </span>
            )}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="size-9" />;
  const dark = resolvedTheme === "dark";
  return (
    <Tooltip>
      <Button
        aria-label="Toggle theme"
        isIconOnly
        variant="ghost"
        size="sm"
        onPress={() => setTheme(dark ? "light" : "dark")}
      >
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>
      <Tooltip.Content>{dark ? "Switch to light" : "Switch to dark"}</Tooltip.Content>
    </Tooltip>
  );
}

/** Shows an "Install" button when the browser offers to install the PWA. */
function InstallButton() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [deferred, setDeferred] = useState<any>(null);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (e: any) => {
      e.preventDefault();
      setDeferred(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  if (!deferred) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      onPress={async () => {
        deferred.prompt();
        await deferred.userChoice.catch(() => {});
        setDeferred(null);
      }}
    >
      <Download className="size-4" />
      <span className="hidden sm:inline">Install</span>
    </Button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me } = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const { data: stats } = useStats(!!me);
  const { data: libData } = useLibraries(!!me);
  const libraries = libData?.libraries ?? [];
  const multiLibrary = !!libData?.multi && libraries.length > 1;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const appName = me?.appName || process.env.NEXT_PUBLIC_APP_NAME || "Nimbus Drive";

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
    }
  }

  const nav = NAV
    .filter((n) => !(n.adminOnly && !me?.isAdmin))
    // with several folders attached, one "My Drive" row would be a lie — the
    // list of folders takes its place
    .filter((n) => !(multiLibrary && n.href === "/"));

  return (
    <div className="flex min-h-dvh w-full">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[var(--nimbus-sidebar-w)] shrink-0 border-r border-default bg-surface/80 backdrop-blur-md transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col gap-2 p-4">
          <Link href="/" className="mb-2 flex items-center gap-2.5 px-2 py-1" onClick={() => setSidebarOpen(false)}>
            <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground shadow-sm">
              <Cloud className="size-5" />
            </span>
            <span className="text-lg font-semibold tracking-tight">{appName}</span>
          </Link>

          <nav className="flex flex-col gap-1">
            {nav.map((n) => {
              const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setSidebarOpen(false)}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent/15 text-accent"
                      : "text-muted hover:bg-foreground/5 hover:text-foreground"
                  }`}
                >
                  <n.icon className="size-4.5" />
                  {n.label}
                </Link>
              );
            })}
          </nav>

          {multiLibrary && (
            <Suspense fallback={null}>
              <LibraryList libraries={libraries} onNavigate={() => setSidebarOpen(false)} />
            </Suspense>
          )}

          <div className="mt-auto">
            {stats && (
              <div className="rounded-xl border border-default bg-background/60 p-3">
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>Storage used</span>
                  <span className="font-medium text-foreground">{formatBytes(stats.bytes)}</span>
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {stats.files.toLocaleString()} files · {stats.folders.toLocaleString()} folders
                </p>
              </div>
            )}
            <p className="mt-3 px-1 text-[11px] leading-relaxed text-muted">
              Self-hosted · your files never leave your machine
            </p>
          </div>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-default bg-background/80 px-3 py-3 backdrop-blur-md sm:gap-3 sm:px-4">
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            className="lg:hidden"
            aria-label="Open menu"
            onPress={() => setSidebarOpen(true)}
          >
            <MenuIcon className="size-5" />
          </Button>

          <SearchBox />

          <div className="ml-auto flex items-center gap-1.5">
            <InstallButton />
            <ThemeToggle />
            {me && (
              <Dropdown>
                <Button variant="ghost" isIconOnly aria-label="Account" className="rounded-full">
                  <Avatar className="size-8">
                    <Avatar.Fallback>{me.email.slice(0, 1).toUpperCase()}</Avatar.Fallback>
                  </Avatar>
                </Button>
                <Dropdown.Popover placement="bottom end">
                  <Dropdown.Menu
                    onAction={(key) => {
                      if (key === "logout") logout();
                    }}
                  >
                    <Dropdown.Item id="email" isDisabled textValue={me.email}>
                      <Label>{me.email}</Label>
                    </Dropdown.Item>
                    <Dropdown.Item id="logout" textValue="Sign out" variant="danger">
                      <LogOut className="size-4" />
                      <Label>Sign out</Label>
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            )}
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
