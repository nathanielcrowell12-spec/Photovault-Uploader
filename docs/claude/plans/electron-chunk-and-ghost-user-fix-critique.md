# QA Critic Review: Electron Chunk + Ghost User Fix Plan

**Reviewed:** 2026-01-20
**Plan File:** `electron-chunk-and-ghost-user-fix-plan.md`
**Reviewer:** QA Critic Expert

---

## Summary Verdict: NEEDS REVISION

The plan correctly identifies both root causes and proposes reasonable fixes, but contains **incorrect line number references** and **an incomplete fix for the ghost user bug** that will leave edge cases unfixed.

---

## Critical Issues (Must Fix)

### 1. Incorrect Line Numbers Throughout the Plan

**Problem:** The plan references line numbers that do not match the actual source files.

| Plan Says | Actual |
|-----------|--------|
| `upload-manager.ts` line 310 | Line 310 is the correct location |
| `main.ts` lines 540-564 | Lines 539-564 - off by one |
| `main.ts` line 517 for new variable | No relevant code at 517 |

**Actual locations in main.ts:**
- Token validation success: Line 540 (`logger.info('[Auth] Token validated successfully'...`)
- Auth-complete send: Lines 555-564 (the `if (tokenValid)` block)

**Fix Required:** Update all line number references to match actual source code.

### 2. Ghost User Fix is Incomplete - Protocol Handlers Not Addressed

**Problem:** The plan only fixes the startup validation path (lines 539-564), but the ghost user ID bug can also occur through THREE other code paths that receive auth credentials:

1. **`app.on('open-url')` handler (lines 224-271)** - macOS/Linux protocol handler
2. **`app.on('second-instance')` handler (lines 279-329)** - Windows protocol handler
3. **`createDevServer()` HTTP POST /auth (lines 353-396)** - Dev server auth

All three paths call `authStore.saveAuth()` with the user-provided `userId` from the URL/request and then send `auth-complete` with that same value. They do NOT validate the token before trusting the userId.

**Example from lines 243-257:**
```typescript
// Save to secure persistent storage
authStore.saveAuth({
  token,
  userId: userIdParam,  // <-- Trusts URL parameter blindly
  ...
})

// Notify renderer
mainWindow.webContents.send('auth-complete', {
  userId: userIdParam,  // <-- Sends unvalidated userId
  ...
})
```

**Risk:** An attacker (or a stale URL) could pass `userId=wrong-user` in the protocol URL, and the app would store and display that wrong user ID.

**Fix Required:** Either:
- (A) Validate the token in ALL auth paths before trusting userId, OR
- (B) Add a comment explaining why protocol-delivered credentials are trusted (they come from the PhotoVault web server, which already validated them)

Option B is likely correct - the web server validates the session before generating the protocol URL. But this assumption should be documented.

### 3. Missing Variable Declaration Location

**Problem:** The plan says to add `validatedUserIdForEvent` at line 517, but doesn't specify where relative to the existing code structure. Looking at the actual code, line 517 is `let tokenValid = false` - the variable should be declared near there but the plan doesn't show the full context.

**Fix Required:** Show the complete code block with the new variable declaration in proper context:

```typescript
// Line 517 area
let tokenValid = false
let validatedUserIdForEvent: string | null = null  // ADD THIS LINE

if (supabaseUrl && supabaseAnonKey) {
  // ... validation code ...
```

---

## Concerns (Should Address)

### 4. No Fallback if Validated UserID is Missing

**Problem:** If `data.user.id` is somehow undefined/null (shouldn't happen, but defensive coding), the plan would still set `validatedUserIdForEvent` to that value.

**Recommendation:** Add defensive check:
```typescript
const validatedUserId = data.user?.id
if (!validatedUserId) {
  logger.warn('[Auth] Validation returned user without ID - clearing auth')
  authStore.clearAuth()
  return // or set tokenValid = false
}
```

### 5. Chunk Size Justification Could Be Stronger

**Concern:** The plan says Vercel limit is "~4.5MB" but doesn't cite the actual documentation. The Vercel docs say:
- Hobby: 4.5MB request body
- Pro: 4.5MB (can be increased to 6MB in some cases)

**Recommendation:** Add the exact Vercel documentation link and specify which tier PhotoVault uses. If Pro tier with increased limits, 4MB might be too conservative.

### 6. Race Condition on Auth Store Update

**Minor Concern:** The plan updates `authStore.saveAuth()` and then immediately uses the stored values. If `saveAuth()` is async or has any delay, there could be a race condition.

**Recommendation:** Verify `SecureAuthStore.saveAuth()` is synchronous, or use the validated values directly in the `auth-complete` event rather than re-reading from store.

---

## Minor Notes

### 7. Comment Could Be Clearer

The proposed comment `// 4MB chunks - Vercel limit is ~4.5MB` could be improved to:
```typescript
// 4MB chunks - Vercel serverless body limit is 4.5MB, with ~200KB FormData overhead
```

### 8. Testing Steps Missing Edge Case

**Testing steps should include:**
- Test with a user who has existing stale auth stored
- Verify the mismatch warning is logged
- Verify the auth store is updated with correct userId

Current testing only covers the happy path of "delete auth and re-authenticate."

### 9. Gotchas Section is Good but Incomplete

The gotcha about "existing stored auth may have wrong userId" is good, but should also mention that users who authenticate via protocol URL (not stored auth) may also have issues if the web server ever sends the wrong userId.

---

## What the Plan Gets Right

1. **Correct root cause identification** - Both bugs are accurately diagnosed with evidence from logs and code.

2. **Chunk size fix is correct** - 6MB to 4MB is the right approach for Vercel compatibility.

3. **Security considerations are sound** - The plan correctly notes no new attack surface and fail-closed behavior.

4. **The general approach to the ghost user fix** - Using validated userId instead of stored is correct.

5. **Including authStore update** - Updating the store when mismatch detected is good for persistence.

6. **Retry logic preserved** - The plan doesn't break the existing 3-retry mechanism.

---

## Recommendation

**Revise the plan to:**

1. Fix all line number references to match actual source code

2. Add a section addressing the protocol handler paths (lines 243-257, 306-321, 369-388) - either:
   - Add validation to those paths too, OR
   - Document why they're trusted (web server already validated)

3. Show the complete code context for where `validatedUserIdForEvent` is declared

4. Add defensive null check for `data.user.id`

5. Expand testing steps to include the mismatch scenario

Once these revisions are made, the plan should be **APPROVED**.

---

*QA Critic Review Complete*
