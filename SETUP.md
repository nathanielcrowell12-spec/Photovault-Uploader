# PhotoVault Desktop - Setup Guide

## Quick Start

### 1. Configure Supabase Credentials

Edit `config.json` and add your Supabase credentials:

```json
{
  "supabaseUrl": "https://your-project.supabase.co",
  "supabaseAnonKey": "your_anon_key_here",
  "photoVaultWebUrl": "http://localhost:3000"
}
```

**Where to find these:**
- Go to your Supabase project dashboard
- Click "Settings" → "API"
- Copy the "Project URL" and "anon public" key

### 2. Make Sure Web Server is Running

The desktop app needs the PhotoVault web server running:

```bash
cd photovault-hub
npm run dev
```

Server should be running at `http://localhost:3000`

### 3. Run the Desktop App

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

## First Upload Test

1. **Launch the app** - A window will open and an icon will appear in your system tray
2. **Drag a ZIP file** onto the drop zone (or click to browse)
3. **Enter gallery name** - e.g., "Wedding Photos"
4. **Select platform** - e.g., "Pixieset"
5. **Click "Start Upload"** - Watch the progress bar!

## System Tray Features

Right-click the tray icon to:
- **Open PhotoVault Desktop** - Show/hide the upload window
- **Upload ZIP File** - Quick file picker
- **Open PhotoVault Web** - Opens your dashboard in browser
- **Quit** - Exit the app completely

## How It Works

### Upload Flow:

1. **Desktop App** → Selects file from your computer
2. **Web API** → Creates gallery record and gets upload URL
3. **TUS Protocol** → Uploads file in 6MB chunks directly to Supabase
4. **Resumable** → If interrupted, automatically resumes from last chunk
5. **Web API** → Processes ZIP and extracts photos
6. **Dashboard** → Photos appear in your gallery!

### Why This Works Better:

✅ **Native file access** - No memory limits
✅ **True resumable** - Survives computer restarts
✅ **Background operation** - Upload while you work
✅ **TUS protocol** - Industry standard (Vimeo, Cloudflare use it)
✅ **Direct to cloud** - Doesn't go through your Next.js server

## Troubleshooting

### "Upload manager not initialized"
- Make sure the app fully loaded before clicking upload
- Check console for errors

### "Failed to prepare upload"
- Verify web server is running at `http://localhost:3000`
- Check `config.json` has correct `photoVaultWebUrl`

### "TUS upload failed"
- Check Supabase credentials in `config.json`
- Verify internet connection
- Check firewall isn't blocking uploads

### Can't find system tray icon
- Look in the bottom-right corner of Windows (near clock)
- Click the "^" arrow to show hidden icons

## Building Installer

To create a Windows installer:

```bash
npm run dist
```

This creates `PhotoVault-Desktop-Setup.exe` in the `release/` folder.

## Next Steps

1. **Test with your 1.6GB ZIP file**
2. **Verify it resumes** - Try canceling and restarting
3. **Check dashboard** - Photos should appear after processing
4. **Build installer** - Share with users who need large file uploads

## Production Deployment

For production:

1. Update `config.json` with production URLs
2. Build installer: `npm run dist`
3. Sign the installer (optional but recommended)
4. Distribute to users via your website
5. Set up auto-update server (optional)

## Support

If you encounter issues:
1. Check the console logs in the app
2. Check the web server logs
3. Verify Supabase Storage bucket permissions
4. Test with a smaller ZIP file first (100MB)

---

**Built with Electron + TUS Protocol**


