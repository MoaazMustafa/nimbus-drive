import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";

/**
 * All configuration lives in ONE file: the .env at the project root.
 * We parse it here (no extra deps) so the web app knows where the API lives.
 */
function rootEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const txt = fs.readFileSync(path.join(process.cwd(), "..", ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch {
    /* no .env yet — defaults apply */
  }
  return out;
}

const env = rootEnv();
const API_PORT = env.API_PORT || "4400";
const API_HOST = env.API_HOST && env.API_HOST !== "0.0.0.0" ? env.API_HOST : "127.0.0.1";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://${API_HOST}:${API_PORT}/api/:path*`,
      },
    ];
  },
  // Long-running streams (big downloads/uploads) must not be cut off by the proxy
  experimental: {
    proxyTimeout: 1000 * 60 * 60 * 6,
  },
  env: {
    NEXT_PUBLIC_APP_NAME: env.APP_NAME || "Nimbus Drive",
  },
};

export default nextConfig;
