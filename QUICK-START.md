# 🚀 Quick Start - PhotoVault Desktop

## Get Running in 2 Minutes

### Step 1: Configure (30 seconds)

Open `config.json` and paste your Supabase credentials:

```json
{
  "supabaseUrl": "https://gqmycgopitxpjkxzrnyv.supabase.co",
  "supabaseAnonKey": "PASTE_YOUR_ANON_KEY_HERE",
  "photoVaultWebUrl": "http://localhost:3000"
}
```

**Get your anon key:**
1. Go to Supabase dashboard
2. Settings → API
3. Copy the "anon public" key

### Step 2: Start Web Server (if not running)

```bash
cd ../photovault-hub
npm run dev
```

Wait for: `✓ Ready in X.Xs`

### Step 3: Launch Desktop App

```bash
cd ../photovault-desktop
npm start
```

A window will open! 🎉

### Step 4: Upload Your File

1. **Drag your 1.6GB ZIP** onto the purple drop zone
2. **Gallery name** will auto-fill from filename
3. **Select "Pixieset"** from dropdown
4. **Click "Start Upload"**

Watch it go! The progress bar will update in real-time.

## What You'll See

```
=== STARTING TUS UPLOAD ===
File: crowellcountryliving-photo-download-1of1.zip 1666593299
[DESKTOP] Starting upload: crowellcountryliving-photo-download-1of1.zip 1666593299
[DESKTOP] Gallery created: abc-123-def
[DESKTOP] Progress: 0.36%
[DESKTOP] Progress: 0.72%
[DESKTOP] Progress: 1.08%
...
[DESKTOP] Upload completed!
```

## Testing Resume Feature

1. Start an upload
2. Wait until it's at 10-20%
3. Close the desktop app completely
4. Reopen it
5. Start the same file again
6. **It will resume from where it left off!** 🎯

## System Tray

Look for the PhotoVault icon in your system tray (bottom-right, near clock).

Right-click it to:
- Upload files without opening the window
- Open PhotoVault web dashboard
- Quit the app

## Success!

When upload completes:
1. ✅ Green success message appears
2. 📸 Photos are being processed
3. 🌐 Check your dashboard at `http://localhost:3000/dashboard`
4. 🎉 Gallery will appear with all photos!

## Next: Build Installer

Once you've tested and it works:

```bash
npm run dist
```

This creates `PhotoVault-Desktop-Setup.exe` in `release/` folder.

Share this with users who need to upload large files!

---

**Note:** The app uses TUS protocol which is the same technology used by:
- Vimeo (video uploads)
- Cloudflare (large file transfers)
- Transloadit (file processing)
- Many enterprise file transfer systems

This is the industry-standard solution for reliable large file uploads. 🚀


