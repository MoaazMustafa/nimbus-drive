"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Avatar, Button, Dropdown, Label, Tooltip } from "@heroui/react";
import {
  Cloud,
  HardDrive,
  Users,
  Link2,
  ShieldCheck,
  Sun,
  Moon,
  LogOut,
  Menu as MenuIcon,
} from "lucide-react";
import { api, formatBytes } from "@/lib/api";
import { useMe, useStats } from "@/lib/hooks";
import { SearchBox } from "./SearchBox";

const NAV = [
  { href: "/", label: "My Drive", icon: HardDrive, needsBrowse: true },
  { href: "/shared", label: "Shared with me", icon: Users, needsBrowse: false },
  { href: "/links", label: "My links", icon: Link2, needsBrowse: true },
  { href: "/admin", label: "Admin", icon: ShieldCheck, adminOnly: true },
];

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

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me } = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const { data: stats } = useStats(!!me?.canBrowse);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const appName = me?.appName || process.env.NEXT_PUBLIC_APP_NAME || "Nimbus Drive";

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
    }
  }

  const nav = NAV.filter((n) => {
    if (n.adminOnly && !me?.isAdmin) return false;
    if (n.needsBrowse && me && !me.canBrowse) return false;
    return true;
  });

  return (
    <div className="flex min-h-dvh w-full">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[var(--nimbus-sidebar-w)] shrink-0 border-r border-default bg-surface/60 backdrop-blur-md transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col gap-2 p-4">
          <Link href="/" className="mb-2 flex items-center gap-2.5 px-2 py-1">
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

          <div className="mt-auto">
            {me?.canBrowse && stats && (
              <div className="rounded-xl border border-default bg-background/60 p-3">
                <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
                  <span>Storage</span>
                  <span>{formatBytes(stats.bytes)}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                  <div className="h-full w-full rounded-full bg-accent/70" />
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
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-default bg-background/80 px-4 py-3 backdrop-blur-md">
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

          {me?.canBrowse ? <SearchBox /> : <div className="flex-1" />}

          <div className="ml-auto flex items-center gap-1.5">
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
