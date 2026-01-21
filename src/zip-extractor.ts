import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import JSZip from 'jszip'
import logger from './logger'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']

export interface ZipExtractionResult {
  extractedPaths: string[]
  tempDir: string
  totalSize: number
}

/**
 * Get the temp directory for ZIP extraction
 * Uses %APPDATA%/photovault-desktop/temp/{uploadId}/
 */
export function getTempDir(uploadId: string): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'temp', uploadId)
}

/**
 * Extract image files from a ZIP to a temp directory
 *
 * Uses streaming to avoid loading entire ZIP into memory.
 * Filters out non-image files and macOS metadata.
 *
 * @param zipPath - Path to the ZIP file
 * @param uploadId - Unique upload ID for temp folder naming
 * @returns Extracted file paths and temp directory
 */
export async function extractZip(
  zipPath: string,
  uploadId: string
): Promise<ZipExtractionResult> {
  const tempDir = getTempDir(uploadId)

  // Create temp directory
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  logger.info('[ZIP] Starting extraction', { zipPath, tempDir })

  // Read ZIP file - JSZip loads the file but processes entries lazily
  const zipBuffer = fs.readFileSync(zipPath)
  const zip = await JSZip.loadAsync(zipBuffer)

  const extractedPaths: string[] = []
  let totalSize = 0
  const entries = Object.values(zip.files)

  logger.info('[ZIP] Found entries', { count: entries.length })

  for (const entry of entries) {
    // Skip directories
    if (entry.dir) continue

    // Skip macOS metadata
    if (entry.name.includes('__MACOSX')) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name.includes('/.')) continue

    // Get filename without path
    const fileName = path.basename(entry.name)

    // Skip hidden files
    if (fileName.startsWith('.')) continue

    // Check extension
    const ext = path.extname(fileName).toLowerCase()
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      logger.debug('[ZIP] Skipping non-image file', { fileName, ext })
      continue
    }

    // Extract file
    const outputPath = path.join(tempDir, fileName)

    try {
      // Get file content as buffer
      const content = await entry.async('nodebuffer')

      // Write to temp directory
      fs.writeFileSync(outputPath, content)

      extractedPaths.push(outputPath)
      totalSize += content.length

      logger.debug('[ZIP] Extracted file', { fileName, size: content.length })
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.warn('[ZIP] Failed to extract file', { fileName, error: errorMessage })
      // Continue with other files
    }
  }

  logger.info('[ZIP] Extraction complete', {
    extractedCount: extractedPaths.length,
    totalSize,
    tempDir
  })

  return {
    extractedPaths,
    tempDir,
    totalSize
  }
}

/**
 * Clean up temp directory after upload completes
 *
 * @param tempDir - Path to temp directory to remove
 */
export function cleanupTempDir(tempDir: string): void {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true })
      logger.info('[ZIP] Cleaned up temp directory', { tempDir })
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.warn('[ZIP] Failed to cleanup temp directory', { tempDir, error: errorMessage })
    // Non-fatal - OS will eventually clean up temp files
  }
}

/**
 * Check if a file is a ZIP archive
 */
export function isZipFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.zip')
}
