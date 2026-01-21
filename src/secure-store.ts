import { safeStorage, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import logger from './logger'

// Use require for electron-store due to ESM/CommonJS interop
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StoreModule = require('electron-store')
const Store = StoreModule.default || StoreModule

interface AuthData {
  token: string
  userId: string
  clientId?: string
  galleryId?: string  // Gallery ID from web - upload to existing gallery with pricing
}

// Version marker to detect incompatible encryption changes
// Increment this when changing encryption strategy
const AUTH_STORE_VERSION = 2

interface StoredData {
  version: number
  encryptedAuth?: string
}

/**
 * SecureAuthStore - Persistent auth storage with graceful corruption recovery
 *
 * Design decisions:
 * - Uses ONLY safeStorage for encryption (not double-encryption with electron-store)
 * - Stores session tokens from web → desktop auth handoff
 * - If encryption unavailable or corrupted, clears auth (user re-auths via web)
 * - Never crashes on startup - always fails gracefully to login screen
 *
 * ASSUMPTION: App uses single-instance lock (requestSingleInstanceLock in main.ts)
 * so race conditions in store initialization are prevented at the app level.
 */
export class SecureAuthStore {
  private store: InstanceType<typeof Store> | null = null
  private initError: Error | null = null
  private initialized = false

  constructor() {
    // Don't initialize in constructor - app.getPath('userData') may not be ready
    // Store will be initialized lazily on first use
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true
    this.initializeStore()
  }

  private initializeStore(): void {
    try {
      // Clean up old v1 corrupted file if it exists
      this.cleanupOldStoreFile()

      this.store = new Store({
        name: 'photovault-auth-v2', // New name to avoid old corrupted files
        // NO encryptionKey - we only use safeStorage for encryption
        // This avoids the double-encryption problem where DPAPI failures
        // produce valid JSON that clearInvalidConfig can't detect
        clearInvalidConfig: true
      })
      logger.info('[SecureStore] Store initialized successfully')
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[SecureStore] Failed to create store - attempting recovery', { error: errorMessage })
      this.attemptRecovery()
    }
  }

  private cleanupOldStoreFile(): void {
    try {
      const oldConfigPath = path.join(app.getPath('userData'), 'photovault-auth.json')
      if (fs.existsSync(oldConfigPath)) {
        fs.unlinkSync(oldConfigPath)
        logger.info('[SecureStore] Deleted old v1 auth file during migration')
      }
    } catch {
      // Ignore cleanup errors - old file may not exist or be locked
    }
  }

  private attemptRecovery(): void {
    // Critical Fix #1: Wrap ALL operations in try-catch, including final store creation
    try {
      const configPath = path.join(app.getPath('userData'), 'photovault-auth-v2.json')
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath)
        logger.info('[SecureStore] Deleted corrupted auth file')
      }

      // Also clean up old v1 file if it exists
      this.cleanupOldStoreFile()

      // Critical Fix #1: This was outside try-catch in original plan
      this.store = new Store({
        name: 'photovault-auth-v2',
        clearInvalidConfig: true
      })
      logger.info('[SecureStore] Recovery successful - created fresh store')
    } catch (recoveryError) {
      const errorMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      logger.error('[SecureStore] Recovery failed, operating without persistence', { error: errorMessage })
      this.initError = recoveryError instanceof Error ? recoveryError : new Error(errorMessage)
      this.store = null
      // App continues - user just needs to auth each session
    }
  }

  saveAuth(data: AuthData): void {
    this.ensureInitialized()
    if (!this.store) {
      logger.warn('[SecureStore] Store unavailable, auth will not persist (user will re-auth next session)')
      return
    }

    try {
      // Only store if encryption is available (per user requirement - no plaintext fallback)
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn('[SecureStore] Encryption unavailable - auth will not persist')
        return
      }

      const storedData: StoredData = { version: AUTH_STORE_VERSION }
      const encrypted = safeStorage.encryptString(JSON.stringify(data))
      storedData.encryptedAuth = encrypted.toString('base64')

      this.store.set('data', storedData)
      logger.debug('[SecureStore] Auth data saved for user', { userId: data.userId })
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[SecureStore] Failed to save auth', { error: errorMessage })
      // Don't throw - saving failed but app should continue
    }
  }

  getAuth(): AuthData | null {
    this.ensureInitialized()
    if (!this.store) {
      logger.debug('[SecureStore] Store unavailable, returning null')
      return null
    }

    try {
      const storedData = this.store.get('data') as StoredData | undefined

      if (!storedData) {
        return null
      }

      // Version check - clear if incompatible
      if (storedData.version !== AUTH_STORE_VERSION) {
        logger.info('[SecureStore] Version mismatch, clearing old data', {
          stored: storedData.version,
          expected: AUTH_STORE_VERSION
        })
        this.safeClearAuth()
        return null
      }

      // Must have encrypted auth
      if (!storedData.encryptedAuth) {
        return null
      }

      return this.decryptAuth(storedData.encryptedAuth)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[SecureStore] Failed to get auth - clearing corrupted data', { error: errorMessage })
      // Critical Fix #2: Use safeClearAuth which can't throw
      this.safeClearAuth()
      return null
    }
  }

  private decryptAuth(encryptedBase64: string): AuthData | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn('[SecureStore] Encryption unavailable, cannot decrypt')
        this.safeClearAuth()
        return null
      }

      const decrypted = safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'))
      const parsed = JSON.parse(decrypted)
      return this.validateAuthData(parsed)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Check for common DPAPI errors (expected after rebuild/reinstall)
      if (errorMessage.includes('ciphertext') ||
          errorMessage.includes('decrypt') ||
          errorMessage.includes('DPAPI')) {
        logger.warn('[SecureStore] DPAPI decryption failed (expected after rebuild) - clearing', {
          error: errorMessage
        })
      } else {
        logger.error('[SecureStore] Unexpected decryption error - clearing', { error: errorMessage })
      }

      this.safeClearAuth()
      return null
    }
  }

  private validateAuthData(data: unknown): AuthData | null {
    if (!data || typeof data !== 'object') {
      return null
    }

    const authData = data as Record<string, unknown>

    if (typeof authData.token !== 'string' || typeof authData.userId !== 'string') {
      logger.warn('[SecureStore] Invalid auth data structure - clearing')
      this.safeClearAuth()
      return null
    }

    return {
      token: authData.token,
      userId: authData.userId,
      clientId: typeof authData.clientId === 'string' ? authData.clientId : undefined,
      galleryId: typeof authData.galleryId === 'string' ? authData.galleryId : undefined
    }
  }

  /**
   * Critical Fix #2: Safe version of clearAuth that NEVER throws
   * Used in catch blocks to prevent error propagation
   */
  private safeClearAuth(): void {
    try {
      this.clearAuth()
    } catch {
      // Swallow all errors - we tried our best
      // App continues normally, user just needs to re-auth
    }
  }

  clearAuth(): void {
    this.ensureInitialized()
    try {
      if (this.store) {
        this.store.delete('data')
        logger.debug('[SecureStore] Auth data cleared')
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[SecureStore] Failed to clear auth via store', { error: errorMessage })
      // Last resort: try to delete the file directly
      try {
        const configPath = path.join(app.getPath('userData'), 'photovault-auth-v2.json')
        if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath)
          logger.debug('[SecureStore] Auth file deleted directly')
        }
      } catch {
        // Ignore - we tried everything
      }
    }
  }

  hasAuth(): boolean {
    this.ensureInitialized()
    try {
      if (!this.store) return false
      const data = this.store.get('data') as StoredData | undefined
      return !!data?.encryptedAuth
    } catch {
      return false
    }
  }

  // Expose initialization error for diagnostics
  getInitError(): Error | null {
    return this.initError
  }
}
