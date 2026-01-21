import logger from './logger'

// Use require for electron-store due to ESM/CommonJS interop
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StoreModule = require('electron-store')
const Store = StoreModule.default || StoreModule

export interface UploadState {
  uploadId: string
  galleryId: string
  galleryName: string
  userId: string
  clientId?: string
  authToken?: string
  // File tracking
  filePaths: string[]
  totalFiles: number
  completedFiles: number
  currentFileIndex: number
  // Progress within current file
  currentChunk: number
  totalChunks: number
  // Temp folder for ZIP extraction
  tempFolder?: string
  originalZipPath?: string
  // Timestamps
  startedAt: number
  updatedAt: number
  // Total bytes for progress
  totalSize: number
  bytesUploaded: number
}

interface UploadStateStore {
  uploads: Record<string, UploadState>
}

let store: InstanceType<typeof Store> | null = null

/**
 * Initialize the upload state store
 */
function getStore(): InstanceType<typeof Store> {
  if (!store) {
    try {
      store = new Store({
        name: 'photovault-upload-state',
        clearInvalidConfig: true,
        defaults: { uploads: {} as Record<string, UploadState> }
      })
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[UploadState] Failed to create store', { error: errorMessage })
      throw new Error('Failed to initialize upload state store')
    }
  }
  return store
}

/**
 * Save upload state for resume capability
 *
 * @param state - Current upload state to persist
 */
export function saveUploadState(state: UploadState): void {
  try {
    const s = getStore()
    const uploads = s.get('uploads') as Record<string, UploadState>
    uploads[state.uploadId] = {
      ...state,
      updatedAt: Date.now()
    }
    s.set('uploads', uploads)
    logger.debug('[UploadState] Saved state', {
      uploadId: state.uploadId,
      completedFiles: state.completedFiles,
      totalFiles: state.totalFiles
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[UploadState] Failed to save state', { error: errorMessage })
  }
}

/**
 * Load upload state by ID
 *
 * @param uploadId - The upload ID to load
 * @returns Upload state or null if not found
 */
export function loadUploadState(uploadId: string): UploadState | null {
  try {
    const s = getStore()
    const uploads = s.get('uploads') as Record<string, UploadState>
    return uploads[uploadId] || null
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[UploadState] Failed to load state', { error: errorMessage })
    return null
  }
}

/**
 * Clear upload state after completion
 *
 * @param uploadId - The upload ID to clear
 */
export function clearUploadState(uploadId: string): void {
  try {
    const s = getStore()
    const uploads = s.get('uploads') as Record<string, UploadState>
    delete uploads[uploadId]
    s.set('uploads', uploads)
    logger.info('[UploadState] Cleared state', { uploadId })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[UploadState] Failed to clear state', { error: errorMessage })
  }
}

/**
 * Get all incomplete uploads for resume on startup
 *
 * @returns Array of incomplete upload states
 */
export function getIncompleteUploads(): UploadState[] {
  try {
    const s = getStore()
    const uploads = s.get('uploads') as Record<string, UploadState>
    return Object.values(uploads).filter(
      (state) => state.completedFiles < state.totalFiles
    )
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[UploadState] Failed to get incomplete uploads', { error: errorMessage })
    return []
  }
}

/**
 * Clear all upload states (for manual cleanup)
 */
export function clearAllUploadStates(): void {
  try {
    const s = getStore()
    s.set('uploads', {})
    logger.info('[UploadState] Cleared all states')
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[UploadState] Failed to clear all states', { error: errorMessage })
  }
}

/**
 * Update progress within current file
 *
 * @param uploadId - The upload ID
 * @param currentChunk - Current chunk being uploaded
 * @param totalChunks - Total chunks for current file
 * @param bytesUploaded - Total bytes uploaded so far
 */
export function updateChunkProgress(
  uploadId: string,
  currentChunk: number,
  totalChunks: number,
  bytesUploaded: number
): void {
  const state = loadUploadState(uploadId)
  if (state) {
    state.currentChunk = currentChunk
    state.totalChunks = totalChunks
    state.bytesUploaded = bytesUploaded
    saveUploadState(state)
  }
}

/**
 * Mark a file as completed and move to next
 *
 * @param uploadId - The upload ID
 */
export function markFileCompleted(uploadId: string): void {
  const state = loadUploadState(uploadId)
  if (state) {
    state.completedFiles++
    state.currentFileIndex++
    state.currentChunk = 0
    state.totalChunks = 0
    saveUploadState(state)
    logger.info('[UploadState] File completed', {
      uploadId,
      completedFiles: state.completedFiles,
      totalFiles: state.totalFiles
    })
  }
}
