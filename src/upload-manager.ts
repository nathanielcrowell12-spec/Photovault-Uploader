import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'
import { createClient } from '@supabase/supabase-js'
import logger from './logger'
import { extractZip, cleanupTempDir, isZipFile } from './zip-extractor'
import {
  saveUploadState,
  loadUploadState,
  clearUploadState,
  markFileCompleted,
  updateChunkProgress,
  getIncompleteUploads,
  UploadState
} from './upload-state'

// Load config from env or config.json
// TEMPORARY: Hardcode production URL to test if fetch works
let config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  webUrl: 'https://www.photovault.photo'  // www required - non-www redirects fail
}

// Try to load from config.json if env vars not set
if (!config.supabaseUrl || !config.supabaseAnonKey) {
  try {
    const configPath = path.join(__dirname, '../config.json')
    console.log('[CONFIG DEBUG] __dirname:', __dirname)
    console.log('[CONFIG DEBUG] configPath:', configPath)
    console.log('[CONFIG DEBUG] file exists:', fs.existsSync(configPath))
    const configFile = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    console.log('[CONFIG DEBUG] loaded photoVaultWebUrl:', configFile.photoVaultWebUrl)
    config.supabaseUrl = configFile.supabaseUrl || config.supabaseUrl
    config.supabaseAnonKey = configFile.supabaseAnonKey || config.supabaseAnonKey
    config.webUrl = configFile.photoVaultWebUrl || config.webUrl
    console.log('[CONFIG DEBUG] final webUrl:', config.webUrl)
  } catch (err: unknown) {
    console.error('[CONFIG DEBUG] Failed to load config.json:', err)
    logger.warn('Could not load config.json, using environment variables')
  }
}
console.log('[CONFIG DEBUG] Using webUrl:', config.webUrl)

const supabase = createClient(
  config.supabaseUrl,
  config.supabaseAnonKey
)

export interface UploadOptions {
  filePaths: string[] // Changed to array to support multiple files
  userId: string
  galleryName: string
  platform: string
  clientId?: string
  authToken?: string
  galleryId?: string  // Optional: use existing gallery instead of creating new one
}

export interface UploadStatus {
  uploadId: string
  fileName: string
  fileSize: number
  bytesUploaded: number
  progress: number
  status: 'preparing' | 'uploading' | 'completed' | 'error' | 'cancelled'
  error?: string
  // Speed and ETA tracking
  startTime?: number
  lastUpdateTime?: number
  uploadSpeed?: number // bytes per second
  estimatedTimeRemaining?: number // seconds
}

export interface QueuedUpload {
  id: string
  options: UploadOptions
  failedAt: number
  retryCount: number
  error?: string
}

interface UploadQueueStore {
  uploads: QueuedUpload[]
}

// Use require for electron-store due to ESM/CommonJS interop
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StoreModule = require('electron-store')
const Store = StoreModule.default || StoreModule

export class TusUploadManager extends EventEmitter {
  private uploadStatuses: Map<string, UploadStatus> = new Map()
  private speedSamples: Map<string, number[]> = new Map() // Rolling window of speeds
  private queueStore: InstanceType<typeof Store> | null = null

  constructor() {
    super()
    this.initializeQueueStore()
  }

  private initializeQueueStore(): void {
    try {
      this.queueStore = new Store({
        name: 'photovault-upload-queue',
        clearInvalidConfig: true, // Clear corrupted files automatically
        defaults: { uploads: [] as QueuedUpload[] }
      })
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[Queue] Failed to create queue store - queue will not persist', { error: errorMessage })
      // Continue without queue persistence
      this.queueStore = null
    }
  }

  // Add to failed uploads queue
  private addToQueue(uploadId: string, options: UploadOptions, error: string): void {
    if (!this.queueStore) return // Queue persistence disabled
    const queue = this.queueStore.get('uploads') as QueuedUpload[]
    const existing = queue.find((u: QueuedUpload) => u.id === uploadId)

    if (existing) {
      existing.retryCount++
      existing.failedAt = Date.now()
      existing.error = error
    } else {
      queue.push({
        id: uploadId,
        options,
        failedAt: Date.now(),
        retryCount: 1,
        error
      })
    }

    this.queueStore?.set('uploads', queue)
    logger.info(`[Queue] Added upload ${uploadId} to retry queue`, { uploadId, attempt: existing?.retryCount || 1 })
  }

  // Get queued uploads
  getQueuedUploads(): QueuedUpload[] {
    if (!this.queueStore) return []
    return this.queueStore.get('uploads') as QueuedUpload[]
  }

  // Retry queued upload
  async retryQueuedUpload(uploadId: string): Promise<string | null> {
    if (!this.queueStore) return null
    const queue = this.queueStore.get('uploads') as QueuedUpload[]
    const queued = queue.find((u: QueuedUpload) => u.id === uploadId)

    if (!queued) return null

    try {
      logger.info(`[Queue] Retrying upload ${uploadId}`)
      const newUploadId = await this.startUpload(queued.options)

      // Remove from queue on success
      this.queueStore.set('uploads', queue.filter((u: QueuedUpload) => u.id !== uploadId))
      return newUploadId
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`[Queue] Retry failed for ${uploadId}`, { uploadId, error: errorMessage })
      queued.retryCount++
      queued.failedAt = Date.now()
      queued.error = errorMessage
      this.queueStore.set('uploads', queue)
      return null
    }
  }

  // Clear queue
  clearQueue(): void {
    this.queueStore?.set('uploads', [])
  }

  // Calculate upload speed and ETA
  private updateSpeedAndETA(
    uploadId: string,
    bytesUploaded: number,
    totalSize: number,
    status: UploadStatus
  ): { uploadSpeed: number; estimatedTimeRemaining: number } {
    const now = Date.now()
    const timeSinceLastUpdate = (now - (status.lastUpdateTime || now)) / 1000 // seconds
    const bytesSinceLastUpdate = bytesUploaded - status.bytesUploaded

    // Calculate instantaneous speed
    const instantSpeed = timeSinceLastUpdate > 0
      ? bytesSinceLastUpdate / timeSinceLastUpdate
      : 0

    // Maintain rolling window of last 10 speed samples
    let samples = this.speedSamples.get(uploadId) || []
    if (instantSpeed > 0) {
      samples.push(instantSpeed)
      if (samples.length > 10) samples.shift()
      this.speedSamples.set(uploadId, samples)
    }

    // Calculate average speed from samples
    const avgSpeed = samples.length > 0
      ? samples.reduce((sum, s) => sum + s, 0) / samples.length
      : 0

    // Calculate ETA
    const bytesRemaining = totalSize - bytesUploaded
    const eta = avgSpeed > 0 ? bytesRemaining / avgSpeed : 0

    return { uploadSpeed: avgSpeed, estimatedTimeRemaining: eta }
  }

  async startUpload(options: UploadOptions): Promise<string> {
    const { filePaths, userId, galleryName, platform, clientId, authToken, galleryId } = options

    // Validate at least one file provided
    if (!filePaths || filePaths.length === 0) {
      throw new Error('No files selected')
    }

    // Validate all files exist
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`)
      }
    }

    const uploadId = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // Check for ZIP files and extract them locally
    let actualFilePaths: string[] = []
    let tempFolder: string | null = null
    let originalZipPath: string | null = null

    for (const filePath of filePaths) {
      if (isZipFile(filePath)) {
        logger.info('[DESKTOP] Detected ZIP file, extracting locally...', { filePath })
        originalZipPath = filePath

        try {
          const result = await extractZip(filePath, uploadId)
          actualFilePaths.push(...result.extractedPaths)
          tempFolder = result.tempDir
          logger.info('[DESKTOP] ZIP extracted successfully', {
            extractedCount: result.extractedPaths.length,
            totalSize: result.totalSize
          })
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          logger.error('[DESKTOP] ZIP extraction failed', { error: errorMessage })
          throw new Error(`Failed to extract ZIP file: ${errorMessage}`)
        }
      } else {
        actualFilePaths.push(filePath)
      }
    }

    // If no files after extraction (empty ZIP or no images), throw error
    if (actualFilePaths.length === 0) {
      if (tempFolder) cleanupTempDir(tempFolder)
      throw new Error('No image files found to upload')
    }

    // Calculate total size across all files (after extraction)
    let totalSize = 0
    const fileNames: string[] = []
    for (const filePath of actualFilePaths) {
      const fileStats = fs.statSync(filePath)
      totalSize += fileStats.size
      fileNames.push(path.basename(filePath))
    }

    logger.info('[DESKTOP] Starting multi-file upload', { fileCount: fileNames.length, totalSize, fromZip: !!originalZipPath })

    // Initialize status with timing info for speed/ETA tracking
    const status: UploadStatus = {
      uploadId,
      fileName: fileNames.length === 1 ? fileNames[0] : `${fileNames.length} files`,
      fileSize: totalSize,
      bytesUploaded: 0,
      progress: 0,
      status: 'preparing',
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
      uploadSpeed: 0,
      estimatedTimeRemaining: 0
    }
    this.uploadStatuses.set(uploadId, status)
    this.speedSamples.set(uploadId, [])

    try {
      // Create gallery or use existing one via API endpoint
      if (galleryId) {
        logger.info('[DESKTOP] Using existing gallery from web', { galleryId })
      } else {
        logger.debug('[DESKTOP] Creating new gallery via API...')
      }

      const createGalleryResponse = await fetch(`${config.webUrl}/api/v1/upload/prepare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify({
          fileName: fileNames[0], // Use first file name for gallery creation
          fileSize: totalSize,
          userId,
          clientId: clientId || null,
          galleryName,
          platform: platform || 'desktop',
          galleryId: galleryId || undefined  // Pass existing gallery ID if provided
        })
      })

      if (!createGalleryResponse.ok) {
        const errorText = await createGalleryResponse.text()
        logger.error('[DESKTOP] Gallery creation failed', { error: errorText })
        throw new Error(`Failed to create gallery: ${errorText}`)
      }

      const responseData = await createGalleryResponse.json() as { galleryId: string, storagePath?: string }
      // DEBUG: Log full API response to trace galleryId
      logger.info('[DEBUG] Full API response from /prepare:', {
        responseData: JSON.stringify(responseData),
        keys: Object.keys(responseData),
        hasGalleryId: 'galleryId' in responseData,
        galleryIdType: typeof responseData.galleryId
      })
      // Use response galleryId (could be existing or newly created)
      const targetGalleryId = responseData.galleryId
      logger.info('[DESKTOP] Gallery ready', { galleryId: targetGalleryId, wasExisting: !!galleryId })

      // Track total bytes uploaded across all files
      let totalBytesUploaded = 0

      // Save initial upload state for resume capability
      saveUploadState({
        uploadId,
        galleryId: targetGalleryId,
        galleryName,
        userId,
        clientId,
        authToken,
        filePaths: actualFilePaths,
        totalFiles: actualFilePaths.length,
        completedFiles: 0,
        currentFileIndex: 0,
        currentChunk: 0,
        totalChunks: 0,
        tempFolder: tempFolder || undefined,
        originalZipPath: originalZipPath || undefined,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        totalSize,
        bytesUploaded: 0
      })

      // Upload each file to the same gallery
      for (let fileIndex = 0; fileIndex < actualFilePaths.length; fileIndex++) {
        const filePath = actualFilePaths[fileIndex]
        const fileName = fileNames[fileIndex]
        const fileStats = fs.statSync(filePath)
        const fileSize = fileStats.size

        logger.debug(`[DESKTOP] Uploading file ${fileIndex + 1}/${actualFilePaths.length}`, { fileName, fileSize })

        // Generate storage path for this file
        const fileExt = fileName.split('.').pop()
        const timestamp = Date.now()
        const random = Math.random().toString(36).substring(7)
        const storagePath = `${targetGalleryId}/${timestamp}-${random}.${fileExt}`

        // Upload file in chunks through our API
        const chunkSize = 4 * 1024 * 1024 // 4MB chunks - Vercel serverless body limit is 4.5MB with ~200KB FormData overhead
        const totalChunks = Math.ceil(fileSize / chunkSize)

        logger.debug(`[DESKTOP] Uploading ${totalChunks} chunks for ${fileName}...`, { totalChunks, fileName })

        // Upload each chunk with retry logic
        for (let i = 0; i < totalChunks; i++) {
          const start = i * chunkSize
          const end = Math.min(start + chunkSize, fileSize)

          // Read only this chunk from disk (don't load entire file)
          const chunk = Buffer.alloc(end - start)
          const fileHandle = fs.openSync(filePath, 'r')
          fs.readSync(fileHandle, chunk, 0, end - start, start)
          fs.closeSync(fileHandle)

          let retries = 3
          let uploaded = false

          while (retries > 0 && !uploaded) {
            try {
              const formData = new FormData()
              formData.append('chunk', new Blob([chunk]))
              formData.append('chunkIndex', i.toString())
              formData.append('totalChunks', totalChunks.toString())
              formData.append('uploadId', uploadId)
              formData.append('storagePath', storagePath)

              const chunkResponse = await fetch(`${config.webUrl}/api/v1/upload/chunk`, {
                method: 'POST',
                body: formData
              })

              if (!chunkResponse.ok) {
                const errorText = await chunkResponse.text()
                throw new Error(`Failed to upload chunk ${i}: ${errorText}`)
              }

              uploaded = true
            } catch (error: unknown) {
              retries--
              const errorMessage = error instanceof Error ? error.message : String(error)
              if (retries > 0) {
                logger.debug(`[DESKTOP] Retrying chunk ${i}, ${retries} attempts left...`, { chunk: i, retries })
                await new Promise(resolve => setTimeout(resolve, 2000)) // Wait 2s before retry
              } else {
                throw new Error(`Failed to upload chunk ${i} after 3 attempts: ${errorMessage}`)
              }
            }
          }

          // Update progress across all files
          totalBytesUploaded += (end - start)
          const progress = ((totalBytesUploaded / totalSize) * 100)

          // Calculate speed and ETA
          const { uploadSpeed, estimatedTimeRemaining } = this.updateSpeedAndETA(
            uploadId,
            totalBytesUploaded,
            totalSize,
            status
          )

          // Update status with new values
          status.bytesUploaded = totalBytesUploaded
          status.progress = progress
          status.status = 'uploading'
          status.lastUpdateTime = Date.now()
          status.uploadSpeed = uploadSpeed
          status.estimatedTimeRemaining = estimatedTimeRemaining
          this.uploadStatuses.set(uploadId, status)

          // Log progress with speed
          const speedMBps = (uploadSpeed / 1024 / 1024).toFixed(2)
          logger.debug(`[DESKTOP] Progress: ${progress.toFixed(1)}%`, { progress: progress.toFixed(1), speedMBps, etaSeconds: Math.round(estimatedTimeRemaining) })

          this.emit('progress', uploadId, {
            bytesUploaded: totalBytesUploaded,
            bytesTotal: totalSize,
            progress,
            fileName: `${fileIndex + 1}/${actualFilePaths.length} files`,
            uploadSpeed,
            estimatedTimeRemaining
          })

          // Save chunk progress for resume capability
          updateChunkProgress(uploadId, i + 1, totalChunks, totalBytesUploaded)
        }

        // Process this file's chunks
        logger.debug(`[DESKTOP] Processing ${fileName}...`, { fileName })
        try {
          const processResponse = await fetch(`${config.webUrl}/api/v1/upload/process-chunked`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              galleryId: targetGalleryId,
              storagePath,
              totalChunks
            })
          })

          if (processResponse.ok) {
            logger.info(`[DESKTOP] Processing completed for ${fileName}`, { fileName })
          } else {
            const errorText = await processResponse.text()
            logger.warn(`[DESKTOP] Processing failed for ${fileName}`, { fileName, error: errorText })
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          logger.warn(`[DESKTOP] Failed to trigger processing for ${fileName}`, { fileName, error: errorMessage })
        }

        // Mark this file as completed in state
        markFileCompleted(uploadId)

        // Add a small delay between processing calls to prevent race conditions
        if (fileIndex < actualFilePaths.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }

      // All files uploaded and processed
      logger.info('[DESKTOP] All files uploaded successfully!', { uploadId, galleryId: targetGalleryId, fileCount: actualFilePaths.length })

      status.status = 'completed'
      status.progress = 100
      this.uploadStatuses.set(uploadId, status)

      // Clean up temp folder if we extracted a ZIP
      if (tempFolder) {
        cleanupTempDir(tempFolder)
        logger.info('[DESKTOP] Cleaned up temp folder', { tempFolder })
      }

      // Clear upload state since complete
      clearUploadState(uploadId)

      // DEBUG: Log before emit to trace galleryId through event system
      logger.info('[DEBUG] About to emit complete event:', {
        uploadId,
        galleryId: targetGalleryId,
        galleryIdType: typeof targetGalleryId,
        galleryIdValue: String(targetGalleryId),
        isUndefined: targetGalleryId === undefined,
        isNull: targetGalleryId === null
      })

      this.emit('complete', uploadId, targetGalleryId)

      return uploadId

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[DESKTOP] Failed to start upload', { uploadId, error: errorMessage })
      const status = this.uploadStatuses.get(uploadId)
      if (status) {
        status.status = 'error'
        status.error = errorMessage
        this.uploadStatuses.set(uploadId, status)
      }

      // Add to offline queue for retry
      this.addToQueue(uploadId, options, errorMessage)

      this.emit('error', uploadId, errorMessage)
      throw error
    }
  }

  async cancelUpload(uploadId: string): Promise<void> {
    const status = this.uploadStatuses.get(uploadId)
    if (status) {
      status.status = 'cancelled'
      this.uploadStatuses.set(uploadId, status)
    }
  }

  getUploadStatus(uploadId: string): UploadStatus | undefined {
    return this.uploadStatuses.get(uploadId)
  }

  /**
   * Get incomplete uploads that can be resumed
   */
  getIncompleteUploads(): UploadState[] {
    return getIncompleteUploads()
  }

  /**
   * Resume an incomplete upload from saved state
   *
   * @param uploadId - The upload ID to resume
   * @returns New upload ID for the resumed upload
   */
  async resumeUpload(uploadId: string): Promise<string> {
    const state = loadUploadState(uploadId)
    if (!state) {
      throw new Error(`No saved state found for upload: ${uploadId}`)
    }

    logger.info('[DESKTOP] Resuming upload from saved state', {
      uploadId,
      completedFiles: state.completedFiles,
      totalFiles: state.totalFiles
    })

    // Get remaining files to upload
    const remainingFilePaths = state.filePaths.slice(state.completedFiles)

    if (remainingFilePaths.length === 0) {
      // All files already completed, just clean up
      if (state.tempFolder) {
        cleanupTempDir(state.tempFolder)
      }
      clearUploadState(uploadId)
      throw new Error('Upload already completed')
    }

    // Resume by starting upload with remaining files to existing gallery
    const newUploadId = await this.startUpload({
      filePaths: remainingFilePaths,
      userId: state.userId,
      galleryName: state.galleryName,
      platform: 'desktop',
      clientId: state.clientId,
      authToken: state.authToken,
      galleryId: state.galleryId  // Use existing gallery
    })

    // Clean up old state since we have a new upload ID
    clearUploadState(uploadId)

    return newUploadId
  }

  /**
   * Cancel and clean up an incomplete upload
   *
   * @param uploadId - The upload ID to cancel
   */
  async cancelIncompleteUpload(uploadId: string): Promise<void> {
    const state = loadUploadState(uploadId)
    if (state?.tempFolder) {
      cleanupTempDir(state.tempFolder)
    }
    clearUploadState(uploadId)
    logger.info('[DESKTOP] Cancelled incomplete upload', { uploadId })
  }
}
