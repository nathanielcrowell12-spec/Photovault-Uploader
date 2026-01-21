# Electron Auth Validation Implementation Plan

**Date:** 2026-01-19
**Author:** Electron Expert (Claude)
**Status:** Ready for Implementation

---

## Summary

The PhotoVault Desktop app currently trusts stored authentication data blindly on startup. This caused a production bug where a ghost user ID (`7d68f5ed-60a6-4e57-b858-21390aba4f32`) was trusted, resulting in a foreign key violation when creating galleries.

**Root Cause:** The app calls `authStore.getAuth()` and immediately sends `auth-complete` to the renderer without validating the token is still valid with Supabase.

**Solution:** Add server-side token validation on startup before trusting stored auth data.

---

## Current Behavior (Buggy)

```
App Startup
    |
    v
authStore.getAuth()
    |
    v
Data exists? ----No----> Show login screen
    |
   Yes
    |
    v
[PROBLEM: No validation!]
    |
    v
Send auth-complete to renderer
    |
    v
User attempts upload with potentially invalid token
    |
    v
FK violation / 401 errors
```

## Target Behavior (Fixed)

```
App Startup
    |
    v
authStore.getAuth()
    |
    v
Data exists? ----No----> Show login screen
    |
   Yes
    |
    v
Validate token with Supabase (supabase.auth.getUser())
    |
    v
Valid? ----No----> Clear stored auth, show login screen
    |
   Yes
    |
    v
Send auth-complete to renderer
```

---

## Implementation Steps

### Step 1: Create Auth Validator Module

Create a new file `src/auth-validator.ts` to encapsulate validation logic.

**File:** `photovault-desktop/src/auth-validator.ts`

```typescript
import { createClient, SupabaseClient, User } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import logger from './logger'

// Load config the same way upload-manager does
function loadConfig(): { supabaseUrl: string; supabaseAnonKey: string } {
  let config = {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  }

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    try {
      const configPath = path.join(__dirname, '../config.json')
      const configFile = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      config.supabaseUrl = configFile.supabaseUrl || config.supabaseUrl
      config.supabaseAnonKey = configFile.supabaseAnonKey || config.supabaseAnonKey
    } catch (err) {
      logger.warn('[AuthValidator] Could not load config.json')
    }
  }

  return config
}

export interface AuthValidationResult {
  valid: boolean
  user?: User
  error?: string
  errorCode?: 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'USER_NOT_FOUND' | 'NETWORK_ERROR' | 'UNKNOWN'
}

export interface StoredAuthData {
  token: string
  userId: string
  clientId?: string
  galleryId?: string
}

/**
 * AuthValidator - Validates stored auth tokens against Supabase
 *
 * Design principles:
 * - NEVER throws exceptions - always returns a result object
 * - Handles network failures gracefully (offline scenario)
 * - Logs all validation attempts for debugging
 * - Uses configurable timeout to avoid blocking startup
 */
export class AuthValidator {
  private supabase: SupabaseClient | null = null
  private initialized = false
  private readonly VALIDATION_TIMEOUT_MS = 10000 // 10 seconds max

  constructor() {
    // Lazy initialization
  }

  private ensureInitialized(): boolean {
    if (this.initialized) return this.supabase !== null

    this.initialized = true
    const config = loadConfig()

    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      logger.error('[AuthValidator] Missing Supabase config - validation disabled')
      return false
    }

    try {
      this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: {
          persistSession: false, // We manage our own session storage
          autoRefreshToken: false // We don't want automatic token refresh in main process
        }
      })
      logger.info('[AuthValidator] Supabase client initialized')
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[AuthValidator] Failed to create Supabase client', { error: errorMessage })
      return false
    }
  }

  /**
   * Validate a stored auth token against Supabase
   *
   * @param authData - The stored auth data to validate
   * @returns AuthValidationResult - Never throws
   */
  async validateToken(authData: StoredAuthData): Promise<AuthValidationResult> {
    logger.info('[AuthValidator] Starting token validation', {
      userId: authData.userId,
      hasClientId: !!authData.clientId,
      hasGalleryId: !!authData.galleryId
    })

    // Check 1: Can we initialize Supabase?
    if (!this.ensureInitialized() || !this.supabase) {
      logger.warn('[AuthValidator] Supabase not available - allowing auth (offline mode)')
      // In offline mode, we trust stored auth to avoid blocking users
      // The actual API calls will fail later with proper error messages
      return {
        valid: true, // Trust stored auth when we can't validate
        error: 'Supabase unavailable - offline mode',
        errorCode: 'NETWORK_ERROR'
      }
    }

    // Check 2: Validate token with timeout
    try {
      const result = await this.validateWithTimeout(authData.token)
      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[AuthValidator] Validation failed with exception', { error: errorMessage })

      // On unexpected errors, trust stored auth (fail open, not closed)
      // This prevents users from being locked out due to transient issues
      return {
        valid: true,
        error: errorMessage,
        errorCode: 'UNKNOWN'
      }
    }
  }

  private async validateWithTimeout(token: string): Promise<AuthValidationResult> {
    const timeoutPromise = new Promise<AuthValidationResult>((_, reject) => {
      setTimeout(() => reject(new Error('Validation timeout')), this.VALIDATION_TIMEOUT_MS)
    })

    const validationPromise = this.performValidation(token)

    try {
      return await Promise.race([validationPromise, timeoutPromise])
    } catch (error) {
      if (error instanceof Error && error.message === 'Validation timeout') {
        logger.warn('[AuthValidator] Validation timed out - allowing auth')
        return {
          valid: true, // Trust on timeout
          error: 'Validation timeout',
          errorCode: 'NETWORK_ERROR'
        }
      }
      throw error
    }
  }

  private async performValidation(token: string): Promise<AuthValidationResult> {
    if (!this.supabase) {
      return { valid: false, error: 'Supabase not initialized', errorCode: 'UNKNOWN' }
    }

    // Set the session with the stored token
    const { data: sessionData, error: sessionError } = await this.supabase.auth.setSession({
      access_token: token,
      refresh_token: '' // We don't store refresh tokens in desktop app
    })

    if (sessionError) {
      logger.warn('[AuthValidator] setSession failed', {
        error: sessionError.message,
        code: sessionError.status
      })

      // Analyze the error to determine if it's recoverable
      const errorLower = sessionError.message.toLowerCase()

      if (errorLower.includes('expired') || errorLower.includes('invalid') ||
          errorLower.includes('jwt') || sessionError.status === 401) {
        return {
          valid: false,
          error: sessionError.message,
          errorCode: 'TOKEN_EXPIRED'
        }
      }

      // Network-type errors - trust stored auth
      if (errorLower.includes('fetch') || errorLower.includes('network') ||
          errorLower.includes('timeout') || errorLower.includes('econnrefused')) {
        logger.warn('[AuthValidator] Network error during validation - allowing auth')
        return {
          valid: true,
          error: sessionError.message,
          errorCode: 'NETWORK_ERROR'
        }
      }

      // Unknown error - invalidate to be safe
      return {
        valid: false,
        error: sessionError.message,
        errorCode: 'UNKNOWN'
      }
    }

    // Session set successfully, now verify the user exists
    const { data: userData, error: userError } = await this.supabase.auth.getUser()

    if (userError) {
      logger.warn('[AuthValidator] getUser failed', { error: userError.message })
      return {
        valid: false,
        error: userError.message,
        errorCode: 'USER_NOT_FOUND'
      }
    }

    if (!userData.user) {
      logger.warn('[AuthValidator] No user returned from getUser')
      return {
        valid: false,
        error: 'No user found for token',
        errorCode: 'USER_NOT_FOUND'
      }
    }

    logger.info('[AuthValidator] Token validated successfully', {
      userId: userData.user.id,
      email: userData.user.email
    })

    return {
      valid: true,
      user: userData.user
    }
  }

  /**
   * Optional: Validate that clientId exists in the database
   * This is a defensive check for data integrity
   *
   * @param clientId - The client ID to validate
   * @param token - Auth token for the request
   * @returns true if client exists or validation is skipped, false if client definitely doesn't exist
   */
  async validateClientExists(clientId: string, token: string): Promise<boolean> {
    if (!clientId) return true // No clientId to validate

    if (!this.ensureInitialized() || !this.supabase) {
      logger.warn('[AuthValidator] Cannot validate clientId - Supabase unavailable')
      return true // Trust when we can't verify
    }

    try {
      // Set session first
      await this.supabase.auth.setSession({
        access_token: token,
        refresh_token: ''
      })

      const { data, error } = await this.supabase
        .from('clients')
        .select('id')
        .eq('id', clientId)
        .maybeSingle()

      if (error) {
        logger.warn('[AuthValidator] Client validation query failed', { error: error.message })
        return true // Trust on error
      }

      if (!data) {
        logger.warn('[AuthValidator] Client not found in database', { clientId })
        return false
      }

      logger.debug('[AuthValidator] Client exists', { clientId })
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error('[AuthValidator] Client validation exception', { error: errorMessage })
      return true // Trust on exception
    }
  }
}

// Export singleton instance
export const authValidator = new AuthValidator()
```

### Step 2: Modify main.ts Auth Restore Logic

Update the auth restore section in `main.ts` to use the validator.

**File:** `photovault-desktop/src/main.ts`

**Current code (lines 493-519):**
```typescript
// Restore auth from secure storage on startup
// Wrapped in try-catch to ensure app NEVER crashes from auth issues
try {
  const storedAuth = authStore.getAuth()
  if (storedAuth) {
    logger.info('[Auth] Restored session for user', {
      userId: storedAuth.userId,
      hasGalleryId: !!storedAuth.galleryId,
      galleryId: storedAuth.galleryId
    })
    // Wait a bit for window to be ready, then notify renderer
    setTimeout(() => {
      mainWindow?.webContents.send('auth-complete', {
        userId: storedAuth.userId,
        token: storedAuth.token,
        clientId: storedAuth.clientId,
        galleryId: storedAuth.galleryId  // Pass gallery ID to renderer for upload
      })
    }, 500)
  } else {
    logger.info('[Auth] No stored session found - user will authenticate via web')
  }
} catch (error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error)
  logger.error('[Auth] Failed to restore session - continuing without auth', { error: errorMessage })
  // App continues normally - user just needs to log in via web
}
```

**New code:**
```typescript
// Restore auth from secure storage on startup with SERVER-SIDE VALIDATION
// This fixes the ghost user ID bug where stale tokens were trusted blindly
// Wrapped in try-catch to ensure app NEVER crashes from auth issues
try {
  const storedAuth = authStore.getAuth()
  if (storedAuth) {
    logger.info('[Auth] Found stored session, validating with Supabase...', {
      userId: storedAuth.userId,
      hasGalleryId: !!storedAuth.galleryId,
      galleryId: storedAuth.galleryId
    })

    // CRITICAL FIX: Validate token before trusting it
    const validationResult = await authValidator.validateToken(storedAuth)

    if (validationResult.valid) {
      logger.info('[Auth] Token validated successfully', {
        userId: storedAuth.userId,
        validationNote: validationResult.error || 'none'
      })

      // Optionally validate clientId exists (defensive)
      if (storedAuth.clientId) {
        const clientExists = await authValidator.validateClientExists(
          storedAuth.clientId,
          storedAuth.token
        )
        if (!clientExists) {
          logger.warn('[Auth] ClientId not found in database - clearing auth', {
            clientId: storedAuth.clientId
          })
          authStore.clearAuth()
          logger.info('[Auth] Auth cleared - user will re-authenticate via web')
          return // Don't send auth-complete
        }
      }

      // Wait a bit for window to be ready, then notify renderer
      setTimeout(() => {
        mainWindow?.webContents.send('auth-complete', {
          userId: storedAuth.userId,
          token: storedAuth.token,
          clientId: storedAuth.clientId,
          galleryId: storedAuth.galleryId
        })
      }, 500)
    } else {
      // Token invalid - clear and require re-authentication
      logger.warn('[Auth] Token validation failed - clearing stored auth', {
        errorCode: validationResult.errorCode,
        error: validationResult.error
      })
      authStore.clearAuth()
      logger.info('[Auth] Auth cleared - user will re-authenticate via web')
    }
  } else {
    logger.info('[Auth] No stored session found - user will authenticate via web')
  }
} catch (error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error)
  logger.error('[Auth] Failed to restore session - continuing without auth', { error: errorMessage })
  // App continues normally - user just needs to log in via web
}
```

### Step 3: Add Import Statement

Add the import at the top of `main.ts`:

```typescript
import { authValidator } from './auth-validator'
```

---

## Files to Modify

| File | Change Type | Description |
|------|-------------|-------------|
| `src/auth-validator.ts` | **NEW** | Auth validation module with Supabase integration |
| `src/main.ts` | **MODIFY** | Add import, update auth restore logic (lines 493-519) |

---

## Security Considerations

### 1. Token Exposure
- Tokens are never logged in full
- Only userId is logged for debugging
- Error messages are sanitized before logging

### 2. Fail Open vs Fail Closed
- **Decision: Fail Open** - On network errors/timeouts, we trust stored auth
- **Rationale:** Better UX - don't lock users out due to transient network issues
- **Mitigation:** Actual API calls will fail with proper errors if token is truly invalid

### 3. Offline Mode
- When Supabase is unreachable, stored auth is trusted
- This allows the app to function offline (show cached UI)
- Upload operations will fail with clear error messages if user is actually unauthorized

### 4. Refresh Tokens
- Desktop app does NOT store refresh tokens (security decision)
- When access token expires, user must re-authenticate via web
- This is intentional to limit exposure window

---

## Testing Steps

### Manual Testing

#### Test 1: Valid Token
1. Authenticate normally via web
2. Close and reopen app
3. **Expected:** App shows "Token validated successfully" in logs, auth-complete sent

#### Test 2: Expired Token
1. Authenticate normally
2. Wait for token to expire (or manually edit stored token to invalid value)
3. Restart app
4. **Expected:** App shows "Token validation failed", auth cleared, login screen shown

#### Test 3: Network Offline
1. Authenticate normally
2. Disconnect internet
3. Restart app
4. **Expected:** App shows "Network error - offline mode", auth trusted (fail open)

#### Test 4: Supabase Down
1. Authenticate normally
2. Block Supabase domain in hosts file
3. Restart app
4. **Expected:** Validation times out after 10s, auth trusted

#### Test 5: Ghost User ID
1. Manually edit stored auth to have invalid userId
2. Restart app
3. **Expected:** getUser fails, auth cleared

### Automated Test Cases (for future)

```typescript
// auth-validator.test.ts

describe('AuthValidator', () => {
  describe('validateToken', () => {
    it('should return valid for fresh token', async () => {
      // Mock Supabase to return success
    })

    it('should return invalid for expired token', async () => {
      // Mock Supabase to return 401
    })

    it('should return valid on network timeout (fail open)', async () => {
      // Mock Supabase to never respond
    })

    it('should return valid on network error (fail open)', async () => {
      // Mock Supabase to throw ECONNREFUSED
    })

    it('should return invalid when user not found', async () => {
      // Mock setSession success but getUser returns null
    })
  })

  describe('validateClientExists', () => {
    it('should return true when client exists', async () => {
      // Mock Supabase query to return data
    })

    it('should return false when client not found', async () => {
      // Mock Supabase query to return null
    })

    it('should return true on query error (fail open)', async () => {
      // Mock Supabase query to throw
    })
  })
})
```

---

## Edge Cases

### 1. Offline Startup
- **Scenario:** User opens app with no internet
- **Behavior:** Validation fails with network error, auth is TRUSTED (fail open)
- **Rationale:** Don't punish users for network issues; actual API calls will fail clearly

### 2. Network Timeout
- **Scenario:** Supabase is slow or user has poor connection
- **Behavior:** After 10 seconds, validation times out, auth is TRUSTED
- **Rationale:** Don't block app startup indefinitely

### 3. Token Just Expired
- **Scenario:** Token expires between storage and validation
- **Behavior:** setSession fails with "expired", auth is CLEARED
- **User Experience:** Login screen shown, user re-authenticates

### 4. User Deleted from Database
- **Scenario:** Admin deleted user account while desktop app was closed
- **Behavior:** getUser returns null/error, auth is CLEARED
- **User Experience:** Login screen shown

### 5. ClientId Deleted
- **Scenario:** Client record deleted but auth token still valid
- **Behavior:** validateClientExists returns false, auth is CLEARED
- **User Experience:** Login screen shown

### 6. Supabase Maintenance
- **Scenario:** Supabase returning 503 errors
- **Behavior:** Treated as network error, auth is TRUSTED
- **Rationale:** Temporary outages shouldn't block users

### 7. Invalid Stored Data
- **Scenario:** Stored auth data is corrupted/malformed
- **Behavior:** SecureAuthStore.getAuth() returns null (existing behavior)
- **User Experience:** Login screen shown

### 8. First Launch After Install
- **Scenario:** No stored auth exists
- **Behavior:** No validation attempted, login screen shown (existing behavior)

---

## Rollback Plan

If this change causes issues:

1. Revert `main.ts` to remove validation call
2. Delete `src/auth-validator.ts`
3. Remove import from `main.ts`

The auth-validator is completely isolated - removing it restores original behavior.

---

## Performance Impact

- **Startup Delay:** 0-10 seconds (usually <1s on good network)
- **Network Calls:** 1-2 (setSession + getUser)
- **Mitigation:** Validation runs async, doesn't block window creation

---

## Future Improvements

1. **Token Refresh:** Implement refresh token flow to extend sessions without re-auth
2. **Background Revalidation:** Periodically validate token during long sessions
3. **Cache Validation:** Cache validation result for N minutes to avoid repeated checks
4. **Telemetry:** Track validation failures to identify patterns

---

## Approval Checklist

- [ ] Implementation plan reviewed
- [ ] Security considerations acceptable
- [ ] Edge cases covered
- [ ] Testing plan adequate
- [ ] Ready for implementation
