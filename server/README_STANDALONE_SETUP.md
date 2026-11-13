# Standalone Windows Server Setup Guide for ShopPrint

Follow these simple steps when moving this `server` folder to your i5 3rd Gen (or any Windows PC) to run it as a 24/7 server.

---

## 1. Prerequisites on the Server PC

1. **Node.js LTS (v20 or v22)**
   - Download & install from: [https://nodejs.org](https://nodejs.org)
   - Ensure the checkbox *"Add to PATH"* is checked during installation.

2. **MongoDB Community Server**
   - Download & install from: [https://www.mongodb.com/try/download/community](https://www.mongodb.com/try/download/community)
   - **Crucial**: During install, ensure **"Install MongoDB as a Service"** is checked (this ensures MongoDB starts automatically on Windows boot).

3. **Cloudflare Tunnel (`cloudflared.exe`)** *(For public internet access without static IP)*
   - Download `cloudflared-windows-amd64.exe` from [Cloudflare Releases](https://github.com/cloudflare/cloudflared/releases/latest).
   - Rename it to `cloudflared.exe` and place it in the `server\bin\` folder.

4. **Remote Access (AnyDesk / RustDesk)**
   - Install AnyDesk or RustDesk on the PC.
   - Set an unattended access password so you can manage the PC anytime without a monitor/keyboard attached.

---

## 2. Setting Up 24/7 Power

Run the included batch script as Administrator:
```cmd
OPTIMIZE_PC_FOR_SERVER.bat
```
This disables Windows Sleep, Hibernate, and Standby when plugged in so the server never turns off accidentally.

---

## 3. Starting the Server

You have two easy scripts inside `H:\Print\server\`:

### Option A: `START_BACKGROUND.bat` (Recommended for production)
- Uses **PM2** process manager.
- Runs silently in the background.
- Automatically restarts if a crash occurs.
- You can close the terminal window and the server stays running.
- To view logs: `pm2 logs shopprint-control-plane`
- To stop: `STOP_SERVER.bat`

### Option B: `SETUP_AND_START.bat` (For quick setup / debugging)
- Checks Node, MongoDB, dependencies, seeds DB, starts Cloudflare tunnel, and runs the server in an interactive terminal.

---

## 4. Connecting the Vendor Desktop App

1. Once the server starts, obtain your server URL:
   - **Local network**: `http://<SERVER_LOCAL_IP>:3000` (e.g. `http://192.168.1.15:3000`)
   - **Internet / Cloudflare Tunnel**: Check `server\logs\tunnel.log` for your `https://xxxx.trycloudflare.com` address.
2. In the `server\.env` file, update:
   ```env
   SERVER_BASE_URL=https://xxxx.trycloudflare.com
   SERVER_URL=https://xxxx.trycloudflare.com
   ```
3. In the ShopPrint Desktop App settings or agent configuration, enter that server URL and your shop credentials.
