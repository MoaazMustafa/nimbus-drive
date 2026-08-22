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
  appName: string;
}

/** A public link — anyone with the URL can open the item, no login required. */
export interface Link {
  token: string;
  path: string;
  name: string;
  isDir: boolean;
  kind: Kind;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  url: string;
  exists?: boolean;
  size?: number | null;
  mtime?: number;
}

export interface TrashItem {
  id: string;
  name: string;
  origPath: string;
  isDir: boolean;
  size: number | null;
  deletedBy: string | null;
  deletedAt: number;
  kind: Kind;
}

export interface Activity {
  id: number;
  ts: number;
  email: string | null;
  action: string;
  path: string | null;
  detail: string | null;
  ip: string | null;
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
