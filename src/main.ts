import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } from 'electron'
import * as path from 'path'
import * as dotenv from 'dotenv'
import * as http from 'http'
import * as fs from 'fs'
// url import removed - using Electron's loadFile directly
import { TusUploadManager, UploadStatus, QueuedUpload } from './upload-manager'
import { SecureAuthStore } from './secure-store'
import logger from './logger'
import { createClient } from '@supabase/supabase-js'

dotenv.config()

// =============================================================================
// GLOBAL ERROR HANDLERS - Prevent crash dialogs for non-critical errors
// =============================================================================

// Handle uncaught exceptions - suppress EPIPE errors (broken pipe to console)
process.on('uncaughtException', (error: Error) => {
  // EPIPE errors happen when trying to write to a broken pipe (e.g., console closed)
  // These are non-fatal and should not crash the app
  if (error.message?.includes('EPIPE') || (error as NodeJS.ErrnoException).code === 'EPIPE') {
    logger.debug('Suppressed EPIPE error (non-fatal)', { error: error.message })
    return // Don't crash
  }

  // Log other uncaught exceptions but don't crash for non-critical ones
  logger.error('Uncaught exception', { error: error.message, stack: error.stack })

  // Only re-throw truly critical errors
  // For now, log and continue - the app should remain stable
})

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : 'No stack trace'

  // Suppress EPIPE-related promise rejections
  if (errorMessage?.includes('EPIPE')) {
    logger.debug('Suppressed EPIPE rejection (non-fatal)', { error: errorMessage })
    return
  }

  logger.error('Unhandled promise rejection', { error: errorMessage, stack })
})

// =============================================================================
// AUTO-UPDATER - DISABLED
// =============================================================================
// Auto-updater is disabled because:
// 1. No update server (publish URL) is configured in package.json
// 2. The updater was causing EPIPE crashes when running in the background
// 3. Updates can be distributed manually via new installer downloads
//
// To re-enable auto-updates in the future:
// 1. Add "publish" config to package.json with GitHub releases or other provider
// 2. Uncomment the auto-updater code below
// 3. Rebuild and distribute new installer
// =============================================================================

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let uploadManager: TusUploadManager | null = null
let isQuitting = false
let devServer: http.Server | null = null
let devServerPort: number = 57123

// Debouncing for auth protocol handler to prevent popup spam
let lastProcessedAuthToken: string | null = null
let lastWindowFocusTime: number = 0
const WINDOW_FOCUS_COOLDOWN_MS = 2000 // Only focus window once per 2 seconds

// Use secure persistent storage for auth instead of in-memory variables
const authStore = new SecureAuthStore()

function createWindow() {
  logger.info('[Window] Creating main window...')

  mainWindow = new BrowserWindow({
    width: 600,
    height: 550,
    minWidth: 500,
    minHeight: 400,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    title: 'PhotoVault Desktop',
    show: false // Show after content loads
  })

  logger.info('[Window] BrowserWindow created, loading UI...')

  // Load the upload UI using URL to handle paths with spaces
  const uiPath = path.join(__dirname, '../ui/index.html')
  logger.info('[Window] Loading file:', { path: uiPath })

  // Add error listener for more details
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logger.error('[Window] did-fail-load event', { errorCode, errorDescription, validatedURL })
  })

  // Check if file exists before loading
  if (!fs.existsSync(uiPath)) {
    logger.error('[Window] UI file does not exist!', { path: uiPath })
  } else {
    logger.info('[Window] UI file confirmed to exist')
  }

  // Load the UI HTML file
  logger.info('[Window] Loading UI file:', { path: uiPath })

  mainWindow.loadFile(uiPath).then(() => {
    logger.info('[Window] File loaded successfully!')
  }).catch((err) => {
    logger.error('[Window] Failed to load file', { error: err.message, path: uiPath })
    // Show window anyway to help with debugging
    mainWindow?.show()
  })

  mainWindow.once('ready-to-show', () => {
    logger.info('[Window] ready-to-show event fired, showing window...')
    mainWindow?.show()
    logger.info('[Window] Window shown')
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray() {
  // Use a simple placeholder icon if tray-icon.png doesn't exist
  const iconPath = path.join(__dirname, '../assets/tray-icon.png')

  if (!fs.existsSync(iconPath)) {
    logger.warn('Tray icon not found, skipping tray creation')
    logger.warn('App will still work, just no system tray icon')
    return
  }
  
  tray = new Tray(iconPath)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open PhotoVault Desktop',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
        } else {
          createWindow()
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Upload ZIP File',
      click: async () => {
        const result = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [
            { name: 'ZIP Files', extensions: ['zip'] }
          ]
        })

        if (!result.canceled && result.filePaths.length > 0) {
          const filePath = result.filePaths[0]
          if (mainWindow) {
            mainWindow.show()
            mainWindow.webContents.send('file-selected', filePath)
          }
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Open PhotoVault Web',
      click: () => {
        const webUrl = process.env.PHOTOVAULT_WEB_URL || 'http://localhost:3002'
        require('electron').shell.openExternal(webUrl)
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setToolTip('PhotoVault Desktop')
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
      }
    } else {
      createWindow()
    }
  })
}

// Register custom protocol handler for photovault:// URLs
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('photovault', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('photovault')
}

// Handle protocol launch (photovault://upload, photovault://auth?token=...&userId=...)
app.on('open-url', (event: Electron.Event, url: string): void => {
  event.preventDefault()
  logger.info('Protocol URL received', { url })

  // Parse URL to check for auth parameters
  try {
    const urlObj = new URL(url)
    const token = urlObj.searchParams.get('token')
    const userIdParam = urlObj.searchParams.get('userId')
    const clientIdParam = urlObj.searchParams.get('clientId')
    const galleryIdParam = urlObj.searchParams.get('galleryId')

    if (token && userIdParam) {
      // Auth credentials come from PhotoVault web server which has already validated the session.
      // The web server generates this URL only after successful Supabase authentication.
      // Therefore, we trust the userId in the URL without re-validation.
      logger.info('Auth credentials received from web browser', {
        hasGalleryId: !!galleryIdParam,
        galleryId: galleryIdParam
      })

      // Save to secure persistent storage (including galleryId for upload to existing gallery)
      authStore.saveAuth({
        token,
        userId: userIdParam,
        clientId: clientIdParam || undefined,
        galleryId: galleryIdParam || undefined
      })

      // Notify renderer that authentication is complete
      if (mainWindow) {
        mainWindow.webContents.send('auth-complete', {
          userId: userIdParam,
          token,
          clientId: clientIdParam,
          galleryId: galleryIdParam  // Pass gallery ID to renderer for upload
        })
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('Error parsing protocol URL', { error: errorMessage })
  }

  // Show or create the window when protocol is triggered
  if (mainWindow) {
    mainWindow.show()
  } else {
    createWindow()
  }
})

// Handle command line arguments (Windows protocol handling)
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event: Electron.Event, commandLine: string[], workingDirectory: string): void => {
    // Debounce window focus to prevent popup spam
    const now = Date.now()
    if (mainWindow && (now - lastWindowFocusTime) > WINDOW_FOCUS_COOLDOWN_MS) {
      lastWindowFocusTime = now
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      mainWindow.show()
    }

    // Protocol URL will be in commandLine on Windows
    const url = commandLine.find((arg) => arg.startsWith('photovault://'))
    if (url) {
      // Parse URL to check for auth parameters
      try {
        const urlObj = new URL(url)
        const token = urlObj.searchParams.get('token')
        const userIdParam = urlObj.searchParams.get('userId')
        const clientIdParam = urlObj.searchParams.get('clientId')
        const galleryIdParam = urlObj.searchParams.get('galleryId')

        // Skip if we already processed this exact token (prevents duplicate handling)
        if (token && token === lastProcessedAuthToken) {
          logger.debug('Skipping duplicate auth token', { tokenPrefix: token.substring(0, 20) })
          return
        }

        if (token && userIdParam) {
          lastProcessedAuthToken = token
          logger.info('Auth credentials received from web browser (Windows)', {
            hasGalleryId: !!galleryIdParam,
            galleryId: galleryIdParam
          })

          // Save to secure persistent storage (including galleryId for upload to existing gallery)
          authStore.saveAuth({
            token,
            userId: userIdParam,
            clientId: clientIdParam || undefined,
            galleryId: galleryIdParam || undefined
          })

          // Notify renderer that authentication is complete
          if (mainWindow) {
            mainWindow.webContents.send('auth-complete', {
              userId: userIdParam,
              token,
              clientId: clientIdParam,
              galleryId: galleryIdParam  // Pass gallery ID to renderer for upload
            })
          }
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error('Error parsing protocol URL', { error: errorMessage })
      }
    }
  })
}

// Create local HTTP server for dev testing (bypasses protocol handler issues)
// Uses dynamic port allocation to avoid conflicts
const PREFERRED_PORT = 57123
const PORT_RANGE_START = 57124
const PORT_RANGE_END = 57200

async function createDevServer(): Promise<http.Server | null> {
  const webUrl = process.env.PHOTOVAULT_WEB_URL || 'http://localhost:3002'

  const server = http.createServer((req, res) => {
    // Set CORS headers to allow requests from the hub
    res.setHeader('Access-Control-Allow-Origin', webUrl)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    if (req.method === 'POST' && req.url === '/auth') {
      let body = ''
      req.on('data', chunk => {
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const { token, userId: userIdParam, clientId: clientIdParam, galleryId: galleryIdParam } = data

          if (token && userIdParam) {
            logger.info('[Desktop API] Received auth credentials', {
              hasGalleryId: !!galleryIdParam,
              galleryId: galleryIdParam
            })

            // Save to secure persistent storage (including galleryId for upload to existing gallery)
            authStore.saveAuth({
              token,
              userId: userIdParam,
              clientId: clientIdParam || undefined,
              galleryId: galleryIdParam || undefined
            })

            // Show and focus the window
            if (mainWindow) {
              mainWindow.show()
              mainWindow.focus()

              // Notify renderer that authentication is complete
              mainWindow.webContents.send('auth-complete', {
                userId: userIdParam,
                token,
                clientId: clientIdParam,
                galleryId: galleryIdParam  // Pass gallery ID to renderer for upload
              })
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, port: devServerPort }))
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Missing required fields' }))
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          logger.error('[Desktop API] Error parsing request', { error: errorMessage })
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid JSON' }))
        }
      })
    } else if (req.method === 'GET' && req.url === '/status') {
      // Health check endpoint - helps hub discover if desktop is running
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'running',
        port: devServerPort,
        authenticated: authStore.hasAuth()
      }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  // Try preferred port first, then fall back to range
  const port = await findAvailablePort(server, PREFERRED_PORT, PORT_RANGE_START, PORT_RANGE_END)

  if (port) {
    devServerPort = port
    logger.info(`[Desktop API] Dev server listening on http://localhost:${port}`)
    if (port !== PREFERRED_PORT) {
      logger.warn(`[Desktop API] Using fallback port ${port} (preferred ${PREFERRED_PORT} was in use)`)
    }
    return server
  }

  logger.error('[Desktop API] Could not find available port in range')
  return null
}

function findAvailablePort(
  server: http.Server,
  preferredPort: number,
  rangeStart: number,
  rangeEnd: number
): Promise<number | null> {
  return new Promise((resolve) => {
    // Try preferred port first
    server.listen(preferredPort, 'localhost')

    server.once('listening', () => {
      resolve(preferredPort)
    })

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.debug(`[Desktop API] Port ${preferredPort} in use, trying fallback...`)

        // Try ports in range
        let currentPort = rangeStart

        const tryNextPort = (): void => {
          if (currentPort > rangeEnd) {
            resolve(null)
            return
          }

          server.removeAllListeners('listening')
          server.removeAllListeners('error')

          server.listen(currentPort, 'localhost')

          server.once('listening', () => {
            resolve(currentPort)
          })

          server.once('error', (portErr: NodeJS.ErrnoException) => {
            if (portErr.code === 'EADDRINUSE') {
              currentPort++
              tryNextPort()
            } else {
              resolve(null)
            }
          })
        }

        tryNextPort()
      } else {
        resolve(null)
      }
    })
  })
}

// Initialize upload manager
app.whenReady().then(async () => {
  uploadManager = new TusUploadManager()
  createTray()
  createWindow()

  // Check for incomplete uploads and notify renderer
  const incompleteUploads = uploadManager.getIncompleteUploads()
  if (incompleteUploads.length > 0) {
    logger.info('[Startup] Found incomplete uploads', { count: incompleteUploads.length })
    // Wait for window to be ready, then notify renderer
    setTimeout(() => {
      mainWindow?.webContents.send('incomplete-uploads', incompleteUploads)
    }, 1000)
  }

  // Restore auth from secure storage on startup WITH SERVER-SIDE VALIDATION
  // This fixes the ghost user ID bug where stale tokens were trusted blindly
  // Wrapped in try-catch to ensure app NEVER crashes from auth issues
  try {
    const storedAuth = authStore.getAuth()
    if (storedAuth) {
      logger.info('[Auth] Found stored session, validating with Supabase...', {
        userId: storedAuth.userId,
        hasGalleryId: !!storedAuth.galleryId
      })

      // Load config for Supabase client
      let supabaseUrl = ''
      let supabaseAnonKey = ''
      try {
        const config = require('../config.json')
        supabaseUrl = config.supabaseUrl || ''
        supabaseAnonKey = config.supabaseAnonKey || ''
      } catch {
        logger.warn('[Auth] Could not load config.json for validation')
      }

      // CRITICAL FIX: Validate token before trusting it (fail closed)
      let tokenValid = false
      let validatedUserIdForEvent: string | null = null
      if (supabaseUrl && supabaseAnonKey) {
        try {
          const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            auth: { persistSession: false, autoRefreshToken: false }
          })

          // Validate with 10-second timeout
          const validationPromise = supabase.auth.getUser(storedAuth.token)
          const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) => {
            setTimeout(() => resolve({ data: null, error: new Error('Validation timeout') }), 10000)
          })

          const { data, error } = await Promise.race([validationPromise, timeoutPromise])

          if (error || !data?.user) {
            logger.warn('[Auth] Token validation failed - clearing stored auth', {
              error: error?.message || 'No user returned',
              userId: storedAuth.userId
            })
            authStore.clearAuth()
            // Don't send auth-complete - user must re-login
          } else {
            const validatedUserId = data.user?.id

            // Defensive check - shouldn't happen but fail-closed
            if (!validatedUserId) {
              logger.warn('[Auth] Validation returned user without ID - clearing auth')
              authStore.clearAuth()
              // tokenValid remains false, user must re-login
            } else {
              logger.info('[Auth] Token validated successfully', { userId: validatedUserId })

              // CRITICAL FIX: Check if stored userId matches validated userId
              if (storedAuth.userId !== validatedUserId) {
                logger.warn('[Auth] Stored userId mismatch - updating to validated userId', {
                  stored: storedAuth.userId,
                  validated: validatedUserId
                })
                // Update stored auth with correct userId
                authStore.saveAuth({
                  token: storedAuth.token,
                  userId: validatedUserId,
                  clientId: storedAuth.clientId,
                  galleryId: storedAuth.galleryId
                })
              }

              tokenValid = true
              validatedUserIdForEvent = validatedUserId
            }
          }
        } catch (validationError: unknown) {
          const errorMessage = validationError instanceof Error ? validationError.message : String(validationError)
          logger.warn('[Auth] Token validation exception - clearing stored auth', { error: errorMessage })
          authStore.clearAuth()
          // Don't send auth-complete - user must re-login (fail closed)
        }
      } else {
        logger.warn('[Auth] No Supabase config - cannot validate, clearing auth')
        authStore.clearAuth()
      }

      // Only send auth-complete if token was validated successfully
      if (tokenValid && validatedUserIdForEvent) {
        // Wait a bit for window to be ready, then notify renderer
        setTimeout(() => {
          mainWindow?.webContents.send('auth-complete', {
            userId: validatedUserIdForEvent,  // Use VALIDATED userId, not stored
            token: storedAuth.token,
            clientId: storedAuth.clientId,
            galleryId: storedAuth.galleryId  // Pass gallery ID to renderer for upload
          })
        }, 500)
      }
    } else {
      logger.info('[Auth] No stored session found - user will authenticate via web')
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[Auth] Failed to restore session - continuing without auth', { error: errorMessage })
    // App continues normally - user just needs to log in via web
  }

  // Start dev server for testing (only in development)
  if (process.env.NODE_ENV !== 'production') {
    devServer = await createDevServer()
  }

  // Auto-updater disabled - see comment at top of file

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // Don't quit on window close - keep running in tray
  // Only quit when user explicitly quits from tray menu
})

app.on('before-quit', () => {
  isQuitting = true
})

// IPC Handlers
ipcMain.handle('select-file', async (): Promise<string[] | null> => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Photos and ZIP Files', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'raw', 'cr2', 'nef', 'arw', 'dng', 'zip'] },
      { name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'raw', 'cr2', 'nef', 'arw', 'dng'] },
      { name: 'ZIP Files', extensions: ['zip'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })

  if (!result.canceled && result.filePaths.length > 0) {
    // Return all selected files for multi-file upload support
    return result.filePaths
  }
  return null
})

ipcMain.handle('get-file-stats', async (_event, filePath: string): Promise<{ size: number; name: string } | null> => {
  try {
    const stats = fs.statSync(filePath)
    const name = filePath.split('\\').pop()?.split('/').pop() || 'unknown'

    return {
      size: stats.size,
      name: name
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('Failed to get file stats', { error: errorMessage, filePath })
    return null
  }
})

interface StartUploadParams {
  filePaths: string[]
  userId: string
  galleryName: string
  platform: string
  galleryId?: string  // Optional: use existing gallery instead of creating new one
}

ipcMain.handle('start-upload', async (_event, { filePaths, userId, galleryName, platform, galleryId }: StartUploadParams): Promise<{ success: boolean; uploadId?: string; error?: string }> => {
  try {
    if (!uploadManager) {
      throw new Error('Upload manager not initialized')
    }

    // Get auth from secure storage
    const auth = authStore.getAuth()

    // Only use galleryId if explicitly passed - stored galleryId may be stale
    // (User might have authenticated from a web page with a specific gallery context)
    const targetGalleryId = galleryId

    logger.info('[IPC] Starting upload', {
      hasGalleryId: !!targetGalleryId,
      galleryId: targetGalleryId,
      galleryName
    })

    const uploadId = await uploadManager.startUpload({
      filePaths, // Now accepts array of file paths
      userId,
      galleryName,
      platform,
      clientId: auth?.clientId,
      authToken: auth?.token,
      galleryId: targetGalleryId  // Pass gallery ID to upload to existing gallery
    })
    return { success: true, uploadId }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('cancel-upload', async (_event, uploadId: string): Promise<{ success: boolean }> => {
  if (uploadManager) {
    uploadManager.cancelUpload(uploadId)
  }
  return { success: true }
})

ipcMain.handle('get-upload-status', async (_event, uploadId: string): Promise<UploadStatus | null> => {
  if (!uploadManager) return null
  return uploadManager.getUploadStatus(uploadId) || null
})

// Queue management handlers
ipcMain.handle('get-queued-uploads', async (): Promise<QueuedUpload[]> => {
  if (!uploadManager) return []
  return uploadManager.getQueuedUploads()
})

ipcMain.handle('retry-queued-upload', async (_event, uploadId: string): Promise<{ success: boolean; uploadId?: string | null; error?: string }> => {
  if (!uploadManager) return { success: false, error: 'Upload manager not initialized' }
  try {
    const newUploadId = await uploadManager.retryQueuedUpload(uploadId)
    return { success: !!newUploadId, uploadId: newUploadId }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('clear-upload-queue', async (): Promise<{ success: boolean }> => {
  if (!uploadManager) return { success: false }
  uploadManager.clearQueue()
  return { success: true }
})

// Incomplete upload handlers (for resume capability)
ipcMain.handle('get-incomplete-uploads', async () => {
  if (!uploadManager) return []
  return uploadManager.getIncompleteUploads()
})

ipcMain.handle('resume-incomplete-upload', async (_event, uploadId: string): Promise<{ success: boolean; uploadId?: string; error?: string }> => {
  if (!uploadManager) return { success: false, error: 'Upload manager not initialized' }
  try {
    const newUploadId = await uploadManager.resumeUpload(uploadId)
    return { success: true, uploadId: newUploadId }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('cancel-incomplete-upload', async (_event, uploadId: string): Promise<{ success: boolean }> => {
  if (!uploadManager) return { success: false }
  await uploadManager.cancelIncompleteUpload(uploadId)
  return { success: true }
})

// Authentication handlers
ipcMain.handle('authenticate', async (): Promise<{ authenticated: boolean; userId?: string; token?: string }> => {
  const auth = authStore.getAuth()
  if (auth) {
    return { authenticated: true, userId: auth.userId, token: auth.token }
  }
  return { authenticated: false }
})

ipcMain.handle('logout', async (): Promise<{ success: boolean }> => {
  authStore.clearAuth()
  mainWindow?.webContents.send('auth-cleared')
  return { success: true }
})

ipcMain.handle('open-auth-window', async (): Promise<{ success: boolean; message: string }> => {
  const config = require('../config.json')
  const authUrl = `${config.photoVaultWebUrl}/auth/desktop-callback?desktop=true`

  // Open browser for authentication
  shell.openExternal(authUrl)

  return { success: true, message: 'Please complete authentication in your browser' }
})

ipcMain.handle('set-auth-token', async (_event, token: string, user: string): Promise<{ success: boolean }> => {
  // Save to secure persistent storage
  authStore.saveAuth({ token, userId: user })

  // Notify renderer that authentication is complete
  mainWindow?.webContents.send('auth-complete', { userId: user, token })

  return { success: true }
})

// Gallery browser redirect handler - opens gallery in default browser after upload completes
ipcMain.handle('open-gallery-in-browser', async (_event, galleryId: string): Promise<{ success: boolean; error?: string; url?: string }> => {
  try {
    // Validate galleryId format (any UUID version, not just v4)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(galleryId)) {
      logger.warn('[IPC] Invalid galleryId format rejected', { galleryId })
      return { success: false, error: 'Invalid gallery ID format' }
    }

    // Get hub URL from config
    let hubUrl = process.env.PHOTOVAULT_WEB_URL || 'http://localhost:3002'
    try {
      const config = require('../config.json')
      hubUrl = config.photoVaultWebUrl || hubUrl
    } catch {
      // Config file not found, use default/env
    }

    // Validate URL format
    if (!hubUrl.startsWith('http://') && !hubUrl.startsWith('https://')) {
      logger.error('[IPC] Invalid hub URL format', { hubUrl })
      return { success: false, error: 'Invalid hub URL configuration' }
    }

    // Construct validated URL - redirect to photographer upload page (not public gallery)
    // so photographer can click "Complete & Send to Client" button
    const galleryUrl = `${hubUrl}/photographer/galleries/${galleryId}/upload`

    logger.info('[IPC] Opening gallery in browser', { galleryId, url: galleryUrl })

    // Open in default browser
    await shell.openExternal(galleryUrl)

    return { success: true, url: galleryUrl }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[IPC] Failed to open gallery in browser', { error: errorMessage, galleryId })
    return { success: false, error: errorMessage }
  }
})

// Get web URL from config
ipcMain.handle('get-web-url', async (): Promise<string> => {
  let webUrl = process.env.PHOTOVAULT_WEB_URL || 'https://www.photovault.photo'
  try {
    const config = require('../config.json')
    webUrl = config.photoVaultWebUrl || webUrl
  } catch {
    // Config file not found, use default
  }
  return webUrl
})

// Forward upload progress to renderer (after app is ready)
app.whenReady().then(() => {
  if (uploadManager) {
    uploadManager.on('progress', (uploadId, progress) => {
      mainWindow?.webContents.send('upload-progress', { uploadId, progress })
    })

    uploadManager.on('complete', (uploadId, galleryId) => {
      // DEBUG: Log when event is received in main process
      logger.info('[DEBUG] Complete event received in main.ts:', {
        uploadId,
        galleryId,
        galleryIdType: typeof galleryId,
        galleryIdValue: String(galleryId),
        isUndefined: galleryId === undefined,
        hasMainWindow: !!mainWindow
      })
      mainWindow?.webContents.send('upload-complete', { uploadId, galleryId })
    })

    uploadManager.on('error', (uploadId, error) => {
      mainWindow?.webContents.send('upload-error', { uploadId, error })
    })
  }
})

