// This file runs in the renderer process and has access to the DOM
// It communicates with the main process via the electronAPI

let selectedFiles = [] // Changed to array for multiple files
let currentUploadId = null

// Authentication state
let currentUserId = null
let currentGalleryId = null  // Gallery ID from web wizard — upload to existing gallery
let isAuthenticated = false

// DOM Elements
const dropZone = document.getElementById('drop-zone')
const fileInfo = document.getElementById('file-info')
const fileName = document.getElementById('file-name')
const fileSize = document.getElementById('file-size')
const galleryNameInput = document.getElementById('gallery-name')
const authContainer = document.getElementById('auth-container')
const authBtn = document.getElementById('auth-btn')
const uploadBtn = document.getElementById('upload-btn')
const cancelBtn = document.getElementById('cancel-btn')
const progressContainer = document.getElementById('progress-container')
const progressFill = document.getElementById('progress-fill')
const progressText = document.getElementById('progress-text')
const alertSuccess = document.getElementById('alert-success')
const alertError = document.getElementById('alert-error')
const errorMessage = document.getElementById('error-message')

// Authentication functions
async function checkAuthentication() {
  try {
    console.log('[Desktop Auth] Checking authentication...')

    // Try to get auth from stored electron session first
    const authResult = await window.electronAPI.authenticate()
    if (authResult.authenticated) {
      isAuthenticated = true
      currentUserId = authResult.userId
      updateUIForAuthenticatedState()
      console.log('[Desktop Auth] ✅ Found stored auth:', currentUserId)
      return true
    }

    // If no stored auth, check if user is signed in via web browser
    // Note: This fallback rarely works due to cross-origin restrictions
    // The main auth flow is via protocol handler (photovault://)
    console.log('[Desktop Auth] No stored auth, checking web session...')
    const webUrl = await window.electronAPI.getWebUrl()
    const config = await fetch(`${webUrl}/api/auth/check-session`, {
      credentials: 'include'
    }).catch(() => null)

    if (config && config.ok) {
      const data = await config.json()
      if (data.authenticated && data.userId) {
        isAuthenticated = true
        currentUserId = data.userId

        // Store the auth in electron for next time
        await window.electronAPI.setAuthToken(data.token || '', data.userId)

        updateUIForAuthenticatedState()
        console.log('[Desktop Auth] ✅ Found web session:', data.userId)
        return true
      }
    }

    console.log('[Desktop Auth] ❌ No authentication found')
  } catch (error) {
    console.error('[Desktop Auth] Authentication check failed:', error)
  }
  return false
}

async function startAuthentication() {
  try {
    const result = await window.electronAPI.openAuthWindow()
    if (result.success) {
      showStatus('Please complete authentication in your browser...')
    }
  } catch (error) {
    console.error('Failed to open auth window:', error)
    showError('Failed to open authentication window')
  }
}

function updateUIForAuthenticatedState() {
  // Hide auth button and show upload UI
  authContainer.style.display = 'none'
  uploadBtn.disabled = selectedFiles.length === 0
  uploadBtn.textContent = 'Start Upload'
  console.log('Authenticated as user:', currentUserId)
}

function updateUIForUnauthenticatedState() {
  // Show auth button and disable upload
  authContainer.style.display = 'block'
  uploadBtn.disabled = true
  uploadBtn.textContent = 'Sign In Required'
}

// Drag and Drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropZone.classList.add('active')
})

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('active')
})

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault()
  dropZone.classList.remove('active')

  const files = Array.from(e.dataTransfer.files)
  const validExtensions = ['.zip', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.raw', '.cr2', '.nef', '.arw', '.dng']

  const validFiles = files.filter(file => {
    const fileName = file.name.toLowerCase()
    return validExtensions.some(ext => fileName.endsWith(ext))
  })

  if (validFiles.length > 0) {
    handleFilesSelected(validFiles.map(f => f.path))
  } else {
    showError('Please select photos or a ZIP file')
  }
})

dropZone.addEventListener('click', async () => {
  const filePaths = await window.electronAPI.selectFile()
  if (filePaths) {
    // selectFile now returns an array of paths
    handleFilesSelected(filePaths)
  }
})

// Handle multiple files selection
async function handleFilesSelected(filePaths) {
  try {
    selectedFiles = filePaths

    // Get stats for all files
    let totalSize = 0
    const fileNames = []

    for (const filePath of filePaths) {
      const fileStats = await window.electronAPI.getFileStats(filePath)
      if (fileStats) {
        totalSize += fileStats.size
        fileNames.push(fileStats.name)
      }
    }

    const sizeInMB = (totalSize / 1024 / 1024).toFixed(2)

    // Update UI
    if (filePaths.length === 1) {
      fileName.textContent = fileNames[0]
      fileSize.textContent = `${sizeInMB} MB`
    } else {
      fileName.textContent = `${filePaths.length} files selected`
      fileSize.textContent = `Total: ${sizeInMB} MB`
    }

    fileInfo.classList.add('visible')

    // Auto-fill gallery name from first file
    if (!galleryNameInput.value && fileNames.length > 0) {
      const nameWithoutExt = fileNames[0].replace(/\.(zip|jpg|jpeg|png|gif|webp|heic|raw|cr2|nef|arw|dng)$/i, '')
      galleryNameInput.value = nameWithoutExt
    }

    uploadBtn.disabled = false
    hideAlerts()

    console.log(`${filePaths.length} file(s) selected, total: ${sizeInMB} MB`)
  } catch (error) {
    console.error('Error handling files:', error)
    showError('Failed to select files: ' + error.message)
  }
}

// Backwards compatibility - handle single file
async function handleFileSelected(filePath) {
  await handleFilesSelected([filePath])
}

// Listen for file selection from tray menu
window.electronAPI.onFileSelected((filePath) => {
  handleFileSelected(filePath)
})

// Upload button
uploadBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0 || !galleryNameInput.value.trim()) {
    showError('Please select file(s) and enter a gallery name')
    return
  }

  hideAlerts()
  uploadBtn.disabled = true
  cancelBtn.disabled = false
  progressContainer.classList.add('visible')

  // Check authentication before starting upload
  if (!isAuthenticated || !currentUserId) {
    showError('Please sign in to upload files')
    return
  }

  // Upload all files to the same gallery
  console.log('[Desktop Upload] Starting upload — galleryId:', currentGalleryId)
  const result = await window.electronAPI.startUpload({
    filePaths: selectedFiles, // Pass array of files
    userId: currentUserId,
    galleryName: galleryNameInput.value.trim(),
    platform: 'PhotoVault',
    galleryId: currentGalleryId || undefined  // Use existing gallery if launched from web wizard
  })

  if (result.success) {
    currentUploadId = result.uploadId
    console.log('Upload started:', currentUploadId)
  } else {
    showError(result.error || 'Failed to start upload')
    resetUI()
  }
})

// Cancel button
cancelBtn.addEventListener('click', async () => {
  if (currentUploadId) {
    await window.electronAPI.cancelUpload(currentUploadId)
    showError('Upload cancelled')
    resetUI()
  }
})

// Auth button
authBtn.addEventListener('click', async () => {
  await startAuthentication()
})

// Format time remaining
function formatTimeRemaining(seconds) {
  if (!seconds || seconds <= 0) return ''
  const minutes = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  if (minutes > 0) {
    return `${minutes}m ${secs}s remaining`
  }
  return `${secs}s remaining`
}

// Listen for upload progress
window.electronAPI.onUploadProgress((data) => {
  const { progress, bytesUploaded, bytesTotal, uploadSpeed, estimatedTimeRemaining } = data.progress

  progressFill.style.width = `${progress}%`

  // Format speed
  const speedMBps = uploadSpeed ? (uploadSpeed / 1024 / 1024).toFixed(2) : '0.00'

  // Format ETA
  const etaText = formatTimeRemaining(estimatedTimeRemaining)

  // Build progress text
  const uploadedMB = (bytesUploaded / 1024 / 1024).toFixed(2)
  const totalMB = (bytesTotal / 1024 / 1024).toFixed(2)
  let progressStr = `Uploading... ${progress.toFixed(1)}% (${uploadedMB} MB / ${totalMB} MB)`
  progressStr += ` @ ${speedMBps} MB/s`
  if (etaText) {
    progressStr += ` - ${etaText}`
  }

  progressText.textContent = progressStr
})

// Listen for upload complete
window.electronAPI.onUploadComplete(async (data) => {
  console.log('Upload completed:', data.uploadId, 'galleryId:', data.galleryId)
  resetUI()

  // Open gallery in browser if galleryId is present
  if (data.galleryId) {
    console.log('Opening gallery in browser after short delay...')

    // Small delay to allow server-side processing to start
    // This helps ensure the gallery page has content when user arrives
    await new Promise(resolve => setTimeout(resolve, 2000))

    try {
      const result = await window.electronAPI.openGalleryInBrowser(data.galleryId)

      if (result.success) {
        console.log('Gallery opened successfully in browser:', result.url)
        showStatus('Upload complete! Gallery opened in your browser.')
      } else {
        console.error('Failed to open gallery:', result.error)
        // Include URL so user can manually navigate
        const manualUrl = result.url || `gallery/${data.galleryId}`
        showError(`Upload complete, but could not open browser automatically. Open this URL manually: ${manualUrl}`)
      }
    } catch (error) {
      console.error('Error opening gallery:', error)
      showError(`Upload complete, but could not open browser. Your gallery ID: ${data.galleryId}`)
    }
  } else {
    console.warn('Upload completed but no galleryId received')
    showSuccess()
  }

  // Reset form after delay (longer to show browser opened message)
  setTimeout(() => {
    selectedFiles = []
    fileInfo.classList.remove('visible')
    galleryNameInput.value = ''
    hideAlerts()
  }, 5000)
})

// Listen for upload error
window.electronAPI.onUploadError((data) => {
  console.error('Upload error:', data.error)
  showError(data.error)
  resetUI()
})

// Helper functions
function resetUI() {
  uploadBtn.disabled = selectedFiles.length === 0
  cancelBtn.disabled = true
  progressContainer.classList.remove('visible')
  progressFill.style.width = '0%'
  progressText.textContent = 'Uploading... 0%'
  currentUploadId = null
}

function showSuccess() {
  alertSuccess.classList.add('visible')
  alertError.classList.remove('visible')
}

function showError(message) {
  errorMessage.textContent = message
  alertError.classList.add('visible')
  alertSuccess.classList.remove('visible')
}

function hideAlerts() {
  alertSuccess.classList.remove('visible')
  alertError.classList.remove('visible')
}

// Queue management
async function checkQueue() {
  try {
    const queued = await window.electronAPI.getQueuedUploads()
    const queueContainer = document.getElementById('queue-container')
    const queueList = document.getElementById('queue-list')

    if (queued && queued.length > 0) {
      queueContainer.style.display = 'block'
      renderQueue(queued)
    } else {
      queueContainer.style.display = 'none'
    }
  } catch (error) {
    console.error('Error checking queue:', error)
  }
}

function renderQueue(queued) {
  const queueList = document.getElementById('queue-list')
  queueList.innerHTML = queued.map(item => `
    <div class="queue-item" data-id="${item.id}">
      <div class="queue-info">
        <strong>${item.options?.galleryName || 'Unknown Gallery'}</strong>
        <span class="queue-files">${item.options?.filePaths?.length || 0} file(s)</span>
        <span class="queue-error">${item.error || 'Failed'}</span>
        <span class="queue-attempts">Attempt ${item.retryCount}</span>
      </div>
      <button class="retry-btn btn-secondary" data-id="${item.id}">Retry</button>
    </div>
  `).join('')

  // Attach retry handlers
  document.querySelectorAll('.retry-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const uploadId = e.target.dataset.id
      btn.disabled = true
      btn.textContent = 'Retrying...'

      const result = await window.electronAPI.retryQueuedUpload(uploadId)
      if (result.success) {
        showStatus('Retrying upload...')
        checkQueue() // Refresh queue
      } else {
        showError('Retry failed: ' + (result.error || 'Unknown error'))
        btn.disabled = false
        btn.textContent = 'Retry'
      }
    })
  })
}

async function clearQueue() {
  await window.electronAPI.clearUploadQueue()
  document.getElementById('queue-container').style.display = 'none'
}

function showStatus(message) {
  // Use the success alert for status messages
  const alertSuccess = document.getElementById('alert-success')
  alertSuccess.textContent = message
  alertSuccess.classList.add('visible')
  setTimeout(() => alertSuccess.classList.remove('visible'), 3000)
}

// Initialize authentication and event listeners
document.addEventListener('DOMContentLoaded', async () => {
  console.log('PhotoVault Desktop Helper loaded')

  // Check if user is already authenticated
  const isAuth = await checkAuthentication()
  if (!isAuth) {
    updateUIForUnauthenticatedState()
  }

  // Check for queued (failed) uploads
  checkQueue()

  // Listen for authentication completion
  window.electronAPI.onAuthComplete((data) => {
    isAuthenticated = true
    currentUserId = data.userId
    currentGalleryId = data.galleryId || null
    console.log('[Desktop Auth] Auth complete — galleryId:', currentGalleryId)
    updateUIForAuthenticatedState()
    // If we have a gallery ID from the web, pre-fill the gallery name field
    if (currentGalleryId && galleryNameInput) {
      galleryNameInput.value = galleryNameInput.value || 'Existing Gallery'
      galleryNameInput.disabled = true  // Lock — we're uploading to an existing gallery
      console.log('[Desktop Auth] Locked gallery name — uploading to existing gallery:', currentGalleryId)
    }
    showSuccess('Successfully signed in!')
  })

  // Listen for auth cleared (logout)
  window.electronAPI.onAuthCleared(() => {
    isAuthenticated = false
    currentUserId = null
    updateUIForUnauthenticatedState()
  })

  // Setup queue buttons
  const retryAllBtn = document.getElementById('retry-all-btn')
  const clearQueueBtn = document.getElementById('clear-queue-btn')

  if (retryAllBtn) {
    retryAllBtn.addEventListener('click', async () => {
      const queued = await window.electronAPI.getQueuedUploads()
      for (const item of queued) {
        await window.electronAPI.retryQueuedUpload(item.id)
      }
      checkQueue()
    })
  }

  if (clearQueueBtn) {
    clearQueueBtn.addEventListener('click', async () => {
      await clearQueue()
    })
  }

  // Check for incomplete uploads on startup
  checkIncompleteUploads()

  // Listen for incomplete uploads updates from main process
  if (window.electronAPI.onIncompleteUploads) {
    window.electronAPI.onIncompleteUploads((uploads) => {
      if (uploads && uploads.length > 0) {
        document.getElementById('incomplete-uploads-section').style.display = 'block'
        renderIncompleteUploads(uploads)
      } else {
        document.getElementById('incomplete-uploads-section').style.display = 'none'
      }
    })
  }
})

// ===== INCOMPLETE UPLOADS MANAGEMENT =====

async function checkIncompleteUploads() {
  try {
    const incompleteUploads = await window.electronAPI.getIncompleteUploads()
    const incompleteSection = document.getElementById('incomplete-uploads-section')

    if (incompleteUploads && incompleteUploads.length > 0) {
      incompleteSection.style.display = 'block'
      renderIncompleteUploads(incompleteUploads)
    } else {
      incompleteSection.style.display = 'none'
    }
  } catch (error) {
    console.error('Error checking incomplete uploads:', error)
  }
}

function renderIncompleteUploads(uploads) {
  const incompleteList = document.getElementById('incomplete-uploads-list')

  incompleteList.innerHTML = uploads.map(upload => {
    const completedCount = upload.completedFiles || 0
    const totalCount = upload.totalFiles || upload.filePaths?.length || 0
    const remainingCount = totalCount - completedCount
    const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
    const lastUpdated = upload.updatedAt ? new Date(upload.updatedAt).toLocaleDateString() : 'Unknown'

    return `
      <div class="incomplete-upload-item" data-upload-id="${upload.uploadId}">
        <div class="incomplete-upload-info">
          <strong>${upload.galleryName || 'Untitled Gallery'}</strong>
          <p>${completedCount} of ${totalCount} files uploaded (${progress}%) - ${remainingCount} remaining</p>
          <p class="last-activity">Last activity: ${lastUpdated}</p>
        </div>
        <div class="incomplete-upload-actions">
          <button class="resume-btn" data-upload-id="${upload.uploadId}">▶ Resume</button>
          <button class="discard-btn" data-upload-id="${upload.uploadId}">✕ Discard</button>
        </div>
      </div>
    `
  }).join('')

  // Attach event listeners to buttons
  attachIncompleteUploadHandlers()
}

function attachIncompleteUploadHandlers() {
  // Resume buttons
  document.querySelectorAll('.incomplete-upload-item .resume-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const uploadId = e.target.dataset.uploadId
      btn.disabled = true
      btn.textContent = 'Resuming...'

      try {
        const result = await window.electronAPI.resumeIncompleteUpload(uploadId)

        if (result.success) {
          showStatus('Upload resumed! Continuing where you left off...')
          // Refresh the incomplete uploads list
          checkIncompleteUploads()
        } else {
          showError(`Failed to resume: ${result.error}`)
          btn.disabled = false
          btn.textContent = '▶ Resume'
        }
      } catch (error) {
        console.error('Error resuming upload:', error)
        showError('Error resuming upload. Please try again.')
        btn.disabled = false
        btn.textContent = '▶ Resume'
      }
    })
  })

  // Discard buttons
  document.querySelectorAll('.incomplete-upload-item .discard-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const uploadId = e.target.dataset.uploadId

      if (confirm('Are you sure you want to discard this incomplete upload? This will NOT delete the gallery or photos already uploaded.')) {
        btn.disabled = true
        btn.textContent = 'Discarding...'

        try {
          const result = await window.electronAPI.cancelIncompleteUpload(uploadId)

          if (result.success) {
            showStatus('Incomplete upload discarded. The gallery with existing photos remains on the server.')
            checkIncompleteUploads()
          } else {
            showError('Failed to discard upload.')
            btn.disabled = false
            btn.textContent = '✕ Discard'
          }
        } catch (error) {
          console.error('Error discarding upload:', error)
          btn.disabled = false
          btn.textContent = '✕ Discard'
        }
      }
    })
  })
}
