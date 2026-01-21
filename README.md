# PhotoVault Desktop Helper

A desktop application for uploading large ZIP files to PhotoVault using the industry-standard TUS resumable upload protocol.

## Features

- ✅ **Resumable Uploads** - Automatically resumes if interrupted
- ✅ **Large File Support** - Handles files up to 10GB+
- ✅ **System Tray Integration** - Runs in background like Dropbox
- ✅ **TUS Protocol** - Industry-standard resumable uploads
- ✅ **Direct to Cloud** - Uploads directly to Supabase Storage
- ✅ **Progress Tracking** - Real-time upload progress
- ✅ **Auto-Update** - Keeps itself updated automatically

## Why a Desktop App?

Web browsers have fundamental limitations for large file uploads:
- Memory constraints (can't load 1GB+ files into RAM)
- No true resumable uploads (browser refresh = start over)
- Connection timeouts on slow networks
- Limited background processing

Desktop apps solve these problems by:
- Using native file system access (no memory loading)
- True resumable uploads (survives computer restarts)
- Background operation (upload while you work)
- System-level reliability

**This is why Dropbox, Google Drive, and OneDrive all use desktop apps for large file sync.**

## Installation

### For Users

1. Download `PhotoVault-Desktop-Setup.exe` from releases
2. Run the installer
3. The app will appear in your system tray
4. Right-click the tray icon and select "Upload ZIP File"

### For Developers

1. Clone this repository
2. Copy `env.example` to `.env` and fill in your Supabase credentials
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run in development mode:
   ```bash
   npm run dev
   ```
5. Build for production:
   ```bash
   npm run dist
   ```

## Configuration

Create a `.env` file with:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
PHOTOVAULT_WEB_URL=http://localhost:3000
```

## Usage

### From System Tray

1. Right-click the PhotoVault icon in your system tray
2. Select "Upload ZIP File"
3. Choose your ZIP file
4. Enter gallery name and platform
5. Click "Start Upload"
6. The upload will continue even if you close the window

### Drag and Drop

1. Open the PhotoVault Desktop window
2. Drag your ZIP file onto the drop zone
3. Fill in gallery details
4. Click "Start Upload"

## How It Works

1. **File Selection** - You select a ZIP file from your computer
2. **Gallery Creation** - Creates a gallery record in PhotoVault
3. **TUS Upload** - Uploads file in 6MB chunks using TUS protocol
4. **Processing** - PhotoVault extracts and organizes your photos
5. **Done** - Photos appear in your PhotoVault dashboard

## Technical Details

- **Framework**: Electron
- **Upload Protocol**: TUS (Resumable Uploads)
- **Storage**: Supabase Storage
- **Chunk Size**: 6MB (optimal for reliability)
- **Max File Size**: 10GB+

## Troubleshooting

### Upload stuck at 0%
- Check your internet connection
- Verify Supabase credentials in `.env`
- Check firewall settings

### Upload failed
- The app will automatically retry with exponential backoff
- If it continues to fail, check the console logs

### Can't find the app
- Look for the PhotoVault icon in your system tray (bottom-right corner)
- The app runs in the background even when the window is closed

## Building from Source

### Development
```bash
npm run dev
```

### Production Build
```bash
npm run dist
```

This creates an installer in the `release/` directory.

## License

ISC


