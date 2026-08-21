# Nimbus Drive Migration & Setup Guide

This guide explains how to migrate **Nimbus Drive** from your testing computer to another (or main) computer so that you can access your drive at **`https://cloud.moaazmustafa.dev`** with all your files, users, and settings intact, automatically starting on computer boot/restart.

---

## 🌐 1. Cloud & Domain Settings (One-Time Setup)

### A. Cloudflare DNS CNAME Record
In your [Cloudflare Dashboard](https://dash.cloudflare.com) under `moaazmustafa.dev`:
1. Go to **DNS** → **Add Record**:
   - **Type**: `CNAME`
   - **Name**: `cloud`
   - **Target**: `451d9ecf-d503-4309-bd3a-0974ee86a5e3.cfargotunnel.com`
   - **Proxy Status**: Proxied (Orange Cloud **ON**)
2. Save the DNS record.

### B. Google OAuth Redirect URI
In [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials):
1. Open your OAuth 2.0 Web Client (`nimbus`).
2. Under **Authorized redirect URIs**, add:
   ```text
   https://cloud.moaazmustafa.dev/api/auth/callback/google
   ```
3. Click **Save**.

---

## 📂 2. Data to Copy to the New Computer

Copy these items from your testing machine to your new computer:

1. **Project Directory**: The entire `nimbus-drive` folder. *(Tip: You can delete `node_modules` and `web/.next` before copying to speed up transfer).*
2. **Storage Folder**: Your actual file storage folder (e.g. `C:\Cloud`).
3. **Cloudflare Tunnel Credentials**:
   - Copy `451d9ecf-d503-4309-bd3a-0974ee86a5e3.json` and `cert.pem` from `C:\Users\<TestingUser>\.cloudflared\` on the testing computer to `C:\Users\<NewUser>\.cloudflared\` on the new computer.

---

## 🚀 3. One-Time Setup Steps on the New Computer

Open **Command Prompt** or **PowerShell** inside the `nimbus-drive` folder on your new computer and run:

### Step 1: Install Node.js & Cloudflare CLI (if not already installed)
```cmd
winget install OpenJS.NodeJS.LTS
winget install Cloudflare.cloudflared
```

### Step 2: Install Dependencies & Build Web App
```cmd
npm run install:all
npm run build
```

### Step 3: Verify Environment (`.env`) & Cloudflare Config
- Check [`.env`](file:///.env) file:
  - `BASE_URL=https://cloud.moaazmustafa.dev`
  - `STORAGE_ROOT=C:\Cloud` (or your storage path on the new machine)
- Copy `cloudflared/config.yml` into `%USERPROFILE%\.cloudflared\config.yml`. Update line 2 (`credentials-file`) to match your new username path if needed.

### Step 4: Run the Auto-Start Installer
```cmd
scripts\setup-autostart.bat
```

---

## ⚡ 4. Automatic Startup & Background Execution

- Running `scripts\setup-autostart.bat` places `NimbusDrive.vbs` inside your Windows Startup folder (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`).
- Every time your computer powers on or restarts, Nimbus Drive (API + Web) and Cloudflare Tunnel will start automatically in the background without any pop-up windows.
- Access your cloud drive anytime at **`https://cloud.moaazmustafa.dev`**!
