import { contextBridge, ipcRenderer } from 'electron'

// Type definitions for IPC communication
interface UploadProgressData {
  uploadId: string
  progress: {
    bytesUploaded: number
    bytesTotal: number
    progress: number
    fileName: string
    uploadSpeed: number
    estimatedTimeRemaining: number
  }
}

interface UploadCompleteData {
  uploadId: string
  galleryId?: string
}

interface UploadErrorData {
  uploadId: string
  error: string
}

interface AuthCompleteData {
  userId: string
  token: string
  clientId?: string
  galleryId?: string  // Gallery ID from web - upload to existing gallery with pricing
}

interface StartUploadOptions {
  filePaths: string[]
  userId: string
  galleryName: string
  platform: string
  galleryId?: string  // Optional: use existing gallery instead of creating new one
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (): Promise<string[] | null> => ipcRenderer.invoke('select-file'),

  getFileStats: (filePath: string): Promise<{ size: number; name: string } | null> =>
    ipcRenderer.invoke('get-file-stats', filePath),

  startUpload: (options: StartUploadOptions): Promise<{ success: boolean; uploadId?: string; error?: string }> =>
    ipcRenderer.invoke('start-upload', options),

  cancelUpload: (uploadId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('cancel-upload', uploadId),

  getUploadStatus: (uploadId: string): Promise<unknown> =>
    ipcRenderer.invoke('get-upload-status', uploadId),

  // Queue management
  getQueuedUploads: (): Promise<unknown[]> => ipcRenderer.invoke('get-queued-uploads'),
  retryQueuedUpload: (uploadId: string): Promise<{ success: boolean; uploadId?: string; error?: string }> =>
    ipcRenderer.invoke('retry-queued-upload', uploadId),
  clearUploadQueue: (): Promise<{ success: boolean }> => ipcRenderer.invoke('clear-upload-queue'),

  // Incomplete upload management (for resume capability)
  getIncompleteUploads: (): Promise<unknown[]> => ipcRenderer.invoke('get-incomplete-uploads'),
  resumeIncompleteUpload: (uploadId: string): Promise<{ success: boolean; uploadId?: string; error?: string }> =>
    ipcRenderer.invoke('resume-incomplete-upload', uploadId),
  cancelIncompleteUpload: (uploadId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('cancel-incomplete-upload', uploadId),
  onIncompleteUploads: (callback: (uploads: unknown[]) => void): void => {
    ipcRenderer.on('incomplete-uploads', (_event, uploads: unknown[]) => callback(uploads))
  },

  onFileSelected: (callback: (filePath: string) => void): void => {
    ipcRenderer.on('file-selected', (_event, filePath: string) => callback(filePath))
  },

  onUploadProgress: (callback: (data: UploadProgressData) => void): void => {
    ipcRenderer.on('upload-progress', (_event, data: UploadProgressData) => callback(data))
  },

  onUploadComplete: (callback: (data: UploadCompleteData) => void): void => {
    ipcRenderer.on('upload-complete', (_event, data: UploadCompleteData) => callback(data))
  },

  onUploadError: (callback: (data: UploadErrorData) => void): void => {
    ipcRenderer.on('upload-error', (_event, data: UploadErrorData) => callback(data))
  },

  // Authentication functions
  authenticate: (): Promise<{ authenticated: boolean; userId?: string; token?: string }> =>
    ipcRenderer.invoke('authenticate'),

  openAuthWindow: (): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke('open-auth-window'),

  setAuthToken: (token: string, user: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('set-auth-token', token, user),

  logout: (): Promise<{ success: boolean }> => ipcRenderer.invoke('logout'),

  onAuthComplete: (callback: (data: AuthCompleteData) => void): void => {
    ipcRenderer.on('auth-complete', (_event, data: AuthCompleteData) => callback(data))
  },

  onAuthCleared: (callback: () => void): void => {
    ipcRenderer.on('auth-cleared', () => callback())
  },

  // Browser redirect - opens gallery in default browser after upload
  openGalleryInBrowser: (galleryId: string): Promise<{ success: boolean; error?: string; url?: string }> =>
    ipcRenderer.invoke('open-gallery-in-browser', galleryId),

  // Get web URL from config
  getWebUrl: (): Promise<string> => ipcRenderer.invoke('get-web-url')
})

// Type definitions for renderer
declare global {
  interface Window {
    electronAPI: {
      selectFile: () => Promise<string[] | null>
      getFileStats: (filePath: string) => Promise<{ size: number; name: string } | null>
      startUpload: (options: StartUploadOptions) => Promise<{ success: boolean; uploadId?: string; error?: string }>
      cancelUpload: (uploadId: string) => Promise<{ success: boolean }>
      getUploadStatus: (uploadId: string) => Promise<unknown>
      getQueuedUploads: () => Promise<unknown[]>
      retryQueuedUpload: (uploadId: string) => Promise<{ success: boolean; uploadId?: string; error?: string }>
      clearUploadQueue: () => Promise<{ success: boolean }>
      getIncompleteUploads: () => Promise<unknown[]>
      resumeIncompleteUpload: (uploadId: string) => Promise<{ success: boolean; uploadId?: string; error?: string }>
      cancelIncompleteUpload: (uploadId: string) => Promise<{ success: boolean }>
      onIncompleteUploads: (callback: (uploads: unknown[]) => void) => void
      onFileSelected: (callback: (filePath: string) => void) => void
      onUploadProgress: (callback: (data: UploadProgressData) => void) => void
      onUploadComplete: (callback: (data: UploadCompleteData) => void) => void
      onUploadError: (callback: (data: UploadErrorData) => void) => void
      authenticate: () => Promise<{ authenticated: boolean; userId?: string; token?: string }>
      openAuthWindow: () => Promise<{ success: boolean; message: string }>
      setAuthToken: (token: string, user: string) => Promise<{ success: boolean }>
      logout: () => Promise<{ success: boolean }>
      onAuthComplete: (callback: (data: AuthCompleteData) => void) => void
      onAuthCleared: (callback: () => void) => void
      openGalleryInBrowser: (galleryId: string) => Promise<{ success: boolean; error?: string; url?: string }>
      getWebUrl: () => Promise<string>
    }
  }
}


