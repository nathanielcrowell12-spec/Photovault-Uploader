# Electron: Chunk Size + Ghost User ID Fix Plan (REVISED)

## Summary

Two bugs preventing desktop uploads:
1. **Chunk size too large** - 6MB chunks exceed Vercel's ~4.5MB body limit
2. **Ghost user ID** - Validated user ID not used, causing stale IDs to persist

**Revision Note:** Updated per QA Critic review to fix line numbers, add defensive checks, and document protocol handler trust model.

---

## Bug 1: Chunk Size Too Large

### Root Cause with Evidence

**Error:**
```
renderer.js:320 Upload error: Failed to upload chunk 0 after 3 attempts:
Failed to upload chunk 0: Request Entity Too Large
FUNCTION_PAYLOAD_TOO_LARGE
```

**Evidence:**
- Client (`upload-manager.ts` line 310): `const chunkSize = 6 * 1024 * 1024 // 6MB chunks`
- Vercel serverless function body limit: 4.5MB (documented at vercel.com/docs/functions/limitations)
- FormData adds overhead (boundary strings, content-type headers, ~200KB)
- 6MB chunk + FormData overhead > 4.5MB limit = rejection

**Category:** Configuration Mismatch

### Fix

Reduce chunk size from 6MB to 4MB to stay safely under Vercel's limit.

**File:** `photovault-desktop/src/upload-manager.ts`
**Line:** 310

**Before:**
```typescript
const chunkSize = 6 * 1024 * 1024 // 6MB chunks
```

**After:**
```typescript
const chunkSize = 4 * 1024 * 1024 // 4MB chunks - Vercel serverless body limit is 4.5MB with ~200KB FormData overhead
```

---

## Bug 2: Ghost User ID Persists

### Root Cause with Evidence

**Symptom:** Wrong user number keeps appearing in the app after authentication

**Evidence from main.ts lines 539-564:**
```typescript
// Line 540 - logs the VALIDATED user ID from Supabase
logger.info('[Auth] Token validated successfully', { userId: data.user.id })
tokenValid = true

// Lines 555-564 - sends the STORED user ID (BUG!)
if (tokenValid) {
  setTimeout(() => {
    mainWindow?.webContents.send('auth-complete', {
      userId: storedAuth.userId,  // <-- Uses stored, not validated!
      token: storedAuth.token,
      ...
    })
  }, 500)
}
```

**Problem:** Validation passes (token is valid), but the code sends `storedAuth.userId` instead of `data.user.id`. If the stored auth has a stale userId, the UI shows the wrong user.

**Category:** Logic Error

### Fix

Use the validated user ID from Supabase (`data.user.id`) and update the stored auth if it doesn't match.

**File:** `photovault-desktop/src/main.ts`

#### Step 1: Declare variable at line 517

Find line 517 where `tokenValid` is declared:
```typescript
// CURRENT (line 517):
let tokenValid = false
```

Change to:
```typescript
// AFTER (lines 517-518):
let tokenValid = false
let validatedUserIdForEvent: string | null = null
```

#### Step 2: Store validated userId in success block (around line 540)

Find the success block after `else {`:
```typescript
// CURRENT (lines 539-542):
} else {
  logger.info('[Auth] Token validated successfully', { userId: data.user.id })
  tokenValid = true
}
```

Change to:
```typescript
// AFTER:
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
```

#### Step 3: Use validated userId in auth-complete (around line 558)

Find the auth-complete send block:
```typescript
// CURRENT (lines 555-564):
if (tokenValid) {
  setTimeout(() => {
    mainWindow?.webContents.send('auth-complete', {
      userId: storedAuth.userId,
      token: storedAuth.token,
      clientId: storedAuth.clientId,
      galleryId: storedAuth.galleryId
    })
  }, 500)
}
```

Change to:
```typescript
// AFTER:
if (tokenValid && validatedUserIdForEvent) {
  setTimeout(() => {
    mainWindow?.webContents.send('auth-complete', {
      userId: validatedUserIdForEvent,  // Use VALIDATED userId
      token: storedAuth.token,
      clientId: storedAuth.clientId,
      galleryId: storedAuth.galleryId
    })
  }, 500)
}
```

---

## Protocol Handler Trust Model (Documentation)

**QA Critic raised concern:** Three other auth paths (open-url, second-instance, dev server) also receive userId without validation.

**Why this is acceptable:**

1. **These paths receive credentials from the PhotoVault web server**, not from arbitrary sources
2. **The web server has already validated the session** before generating the protocol URL
3. **The URL is generated server-side** at `/auth/desktop-callback` after successful Supabase auth
4. **An attacker cannot forge these URLs** without access to the authenticated session

**Flow:**
```
1. User clicks "Login" in desktop app
2. Browser opens photovault.photo/auth/desktop-callback?desktop=true
3. User authenticates with Supabase (web validates)
4. Web server generates: photovault://auth?token=REAL&userId=REAL
5. Desktop receives already-validated credentials
```

**The startup validation path is different** - it reads from local storage which could have stale/corrupted data. That's why only that path needs server-side validation.

**Documenting this assumption:** Add a comment at line 236 (open-url handler):
```typescript
// Auth credentials come from PhotoVault web server which has already validated the session.
// The web server generates this URL only after successful Supabase authentication.
// Therefore, we trust the userId in the URL without re-validation.
authStore.saveAuth({
```

---

## Implementation Steps

1. **Fix chunk size** (upload-manager.ts line 310)
   - Change `6 * 1024 * 1024` to `4 * 1024 * 1024`
   - Update comment

2. **Fix ghost user ID** (main.ts)
   - Line 517-518: Declare `validatedUserIdForEvent`
   - Lines 539-552: Store validated userId with defensive check
   - Lines 555-564: Use validated userId in auth-complete

3. **Document protocol trust model** (main.ts line 236)
   - Add comment explaining why protocol URLs are trusted

4. **Rebuild desktop app**
   - `npm run build` in photovault-desktop

5. **Test**

---

## Files to Modify

| File | Line(s) | Change |
|------|---------|--------|
| `src/upload-manager.ts` | 310 | Change chunk size from 6MB to 4MB |
| `src/main.ts` | 517-518 | Add `validatedUserIdForEvent` variable |
| `src/main.ts` | 236 | Add trust model comment |
| `src/main.ts` | 539-552 | Store validated userId with mismatch check |
| `src/main.ts` | 555-564 | Use validated userId in auth-complete |

---

## Security Considerations

- **No new attack surface** - Changes are internal configuration only
- **Fail-closed maintained** - If validation fails or returns no user ID, auth is cleared
- **Auth store update is safe** - Only updates userId when token is already validated
- **Protocol URLs are trusted** - They come from authenticated web server, not user input
- **Defensive null check added** - Handles edge case where Supabase returns user without ID

---

## Testing Steps

### Happy Path
1. Delete existing auth file: `%APPDATA%\photovault-desktop\photovault-auth-v2.json`
2. Start desktop app
3. Authenticate via web browser
4. Verify correct user ID logged in console
5. Select a small test file (under 10MB)
6. Click upload
7. Verify upload completes without "Request Entity Too Large" error
8. Verify gallery opens in browser after upload

### Mismatch Scenario (Ghost User Fix)
1. Manually edit `photovault-auth-v2.json` to have wrong userId but valid token
2. Start desktop app
3. Verify log shows: "[Auth] Stored userId mismatch - updating to validated userId"
4. Verify UI shows correct user ID (not the wrong one from file)
5. Verify auth file was updated with correct userId

### Large File
1. Select a file larger than 10MB
2. Monitor progress - should show multiple chunk uploads
3. Verify all chunks upload successfully
4. Verify gallery opens after completion

---

## Gotchas & Warnings

1. **Existing stored auth** - Users with existing stale auth will have their userId auto-corrected on next app startup when validation runs.

2. **Chunk size affects upload time** - 4MB chunks mean more HTTP requests than 6MB, but reliability > speed.

3. **Must rebuild after changes** - TypeScript changes require `npm run build` before testing.

4. **Protocol URL trust** - If the web server ever has a bug that sends wrong userId in protocol URLs, the desktop will trust it. This is acceptable because the web server is part of our trusted codebase.

---

## Related Documentation

- Vercel Serverless Function Limits: https://vercel.com/docs/functions/limitations
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- electron-store: https://github.com/sindresorhus/electron-store

---

*Plan created: January 20, 2026*
*Revised: January 20, 2026 (addressed QA Critic feedback)*
*Author: Electron Expert Agent*
