export type Kind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "archive"
  | "doc"
  | "sheet"
  | "slides"
  | "file";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  mtime: number;
  kind: Kind;
}

export interface Listing {
  path: string;
  entries: Entry[];
}

export interface Me {
  email: string;
  isAdmin: boolean;
  canBrowse: boolean;
  visibility: "admin_only" | "everyone";
  appName: string;
}

export interface Share {
  token: string;
  path: string;
  name: string;
  isDir: boolean;
  kind: Kind;
  mode: "workspace" | "restricted";
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  url: string;
  members?: string[];
  exists?: boolean;
  size?: number | null;
  mtime?: number;
}

export interface AllowlistRow {
  email: string;
  role: "user" | "admin";
  added_by: string | null;
  added_at: number;
}

export interface UserRow {
  email: string;
  name: string | null;
  picture: string | null;
  first_login_at: number;
  last_login_at: number;
}

export interface Stats {
  files: number;
  folders: number;
  bytes: number;
  truncated: boolean;
}
