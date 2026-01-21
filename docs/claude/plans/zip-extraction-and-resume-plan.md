# Desktop ZIP Extraction + Resume Feature Plan

**Created:** 2026-01-20
**Status:** Ready for implementation

---

## Problem

1. Large ZIP files (500MB+) crash Vercel serverless functions (timeout/memory)
2. No resume capability if upload is interrupted
3. Client-uploaded galleries don't show in dashboard (`user_id` not set)

---

## Solution

Extract ZIPs on the desktop (no limits), upload individual photos, track progress for resume.

---

## Implementation Steps

### 1. Add JSZip dependency
```bash
cd photovault-desktop
npm install jszip
```

### 2. Create zip-extractor.ts
New file: `src/zip-extractor.ts`
- Function to extract ZIP to temp folder
- Returns array of extracted file paths
- Temp folder: `%APPDATA%/photovault-desktop/temp/{uploadId}/`

### 3. Create upload-state.ts
New file: `src/upload-state.ts`
- Persist upload progress to disk using electron-store
- Track: uploadId, galleryId, total files, completed files, current file index, current chunk
- Functions: saveState(), loadState(), clearState(), getIncompleteUploads()

### 4. Modify upload-manager.ts

**In startUpload() at the beginning (after line 217):**
```typescript
// Check for ZIP files and extract them
const expandedFilePaths: string[] = []
let tempFolder: string | null = null

for (const filePath of filePaths) {
  if (filePath.toLowerCase().endsWith('.zip')) {
    // Extract ZIP locally
    const { extractedPaths, tempDir } = await extractZip(filePath, uploadId)
    expandedFilePaths.push(...extractedPaths)
    tempFolder = tempDir
  } else {
    expandedFilePaths.push(filePath)
  }
}

// Use expanded paths instead of original
const actualFilePaths = expandedFilePaths
```

**After each file upload completes (after line 418):**
```typescript
// Save progress state for resume capability
saveUploadState({
  uploadId,
  galleryId: targetGalleryId,
  totalFiles: actualFilePaths.length,
  completedFiles: fileIndex + 1,
  tempFolder
})
```

**After all files complete (after line 431):**
```typescript
// Clean up temp folder if we extracted a ZIP
if (tempFolder && fs.existsSync(tempFolder)) {
  fs.rmSync(tempFolder, { recursive: true })
  logger.info('[DESKTOP] Cleaned up temp folder', { tempFolder })
}

// Clear upload state
clearUploadState(uploadId)
```

### 5. Add resume capability

**New method in TusUploadManager:**
```typescript
async resumeUpload(uploadId: string): Promise<string> {
  const state = loadUploadState(uploadId)
  if (!state) throw new Error('No saved state for upload')

  // Get remaining files
  const remainingFiles = state.filePaths.slice(state.completedFiles)

  // Continue upload from where we left off
  // ... (similar to startUpload but skips completed files)
}
```

**On app startup (in main.ts):**
```typescript
// Check for incomplete uploads
const incomplete = getIncompleteUploads()
if (incomplete.length > 0) {
  // Notify renderer to show resume UI
  mainWindow.webContents.send('incomplete-uploads', incomplete)
}
```

### 6. Deploy hub fix

Commit and push `src/app/api/v1/upload/prepare/route.ts` which already has the `user_id` fix.

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/zip-extractor.ts` | CREATE - ZIP extraction logic |
| `src/upload-state.ts` | CREATE - Progress persistence |
| `src/upload-manager.ts` | MODIFY - Add extraction + state tracking |
| `src/main.ts` | MODIFY - Check for incomplete uploads on startup |
| `ui/renderer.js` | MODIFY - Add resume UI |

---

## Testing

1. Upload a large ZIP (500MB+) - should extract locally and upload photos
2. Close laptop mid-upload - should resume on restart
3. Complete upload - temp folder should be deleted
4. Verify gallery appears in client dashboard

---

## Already Done

- Fixed `prepare/route.ts` to set `user_id` (not deployed yet)
- Fixed existing gallery in database manually
- Identified root cause of ZIP processing failure

---

## Notes

- Original ZIP file is left alone (user manages it)
- Temp folder cleaned up only after ALL photos verified
- If user cancels, temp folder is cleaned up immediately
