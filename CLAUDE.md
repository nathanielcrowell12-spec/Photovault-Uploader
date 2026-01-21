# PhotoVault Desktop - Claude Code Context

**Project:** PhotoVault Desktop - Electron Upload Client
**Status:** Production Ready

---

## Quick Start

```bash
cd "C:\Users\natha\.cursor\Photo Vault\photovault-desktop"
npm run build        # Compile TypeScript
npm start            # Run desktop app
npm run dist         # Build installer
```

---

## Memory System

**This file is minimal by design.** Uses shared skill index from hub.

### On Session Start
1. Read this file
2. Read `Stone-Fence-Brain/VENTURES/PhotoVault/CURRENT_STATE.md`
3. Report status, wait for direction

### For Complex Tasks
Read the shared skill index: `../photovault-hub/.claude/SKILL-INDEX.md`

### Key Paths
| What | Where |
|------|-------|
| **Skill Index** | `../photovault-hub/.claude/SKILL-INDEX.md` |
| **Current State** | `Stone-Fence-Brain/VENTURES/PhotoVault/CURRENT_STATE.md` |
| **Skills** | `Stone-Fence-Brain/VENTURES/PhotoVault/claude/skills/` |
| **Experts** | `Stone-Fence-Brain/VENTURES/PhotoVault/claude/experts/` |

---

## What This App Does

Solves large file upload problems browsers can't handle:

| Problem | Browser | Desktop |
|---------|---------|---------|
| 1GB+ files | Crashes | Streams from disk |
| Connection drops | Fails | Auto-retries |
| Resume upload | Starts over | Resumes automatically |

---

## Architecture

```
photovault-desktop/
├── src/
│   ├── main.ts              # Electron main process
│   ├── upload-manager.ts    # TUS upload logic
│   ├── secure-store.ts      # Auth persistence
│   └── preload.ts           # Secure IPC bridge
├── ui/
│   ├── index.html           # Upload UI
│   └── renderer.js          # UI logic
├── dist/                    # Compiled JS
└── release/                 # Built installers
```

---

## Integration with Hub

### Upload Flow
```
Desktop → /api/v1/upload/prepare → TUS Upload → /api/v1/upload/process → Gallery
```

### Hub Endpoints Used
| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/upload/prepare` | Create gallery, get signed URL |
| `POST /api/v1/upload/process` | Process uploaded ZIP |
| `/auth/desktop-callback` | OAuth callback |

---

## Primary Skill: Electron

Most desktop work uses the **Electron skill/expert**:
- `electron-skill.md` - IPC, security, packaging
- `electron-expert.md` - Research prompts

Other relevant skills: `testing-skill.md`, `image-processing-skill.md`

---

## Technical Details

- **Framework:** Electron
- **Upload Protocol:** TUS (resumable, 6MB chunks)
- **Max File Size:** 10GB+
- **Storage:** Direct to Supabase Storage

---

## The Three Iron Laws

```
1. NO CODE WITHOUT A FAILING TEST FIRST
2. NO FIX WITHOUT ROOT CAUSE IDENTIFIED
3. NO "IT'S DONE" WITHOUT EVIDENCE
```

---

## Cross-Project Warning

Changes here may break hub, and vice versa:
- API endpoint changes
- Auth token format
- Supabase bucket policies

**Always test full flow:** Desktop upload → Hub processing → Gallery display

---

## Session Save Protocol

Update: `Stone-Fence-Brain/VENTURES/PhotoVault/CURRENT_STATE.md`

Include: date, accomplishments, in-progress items, files modified.

---

*~90 lines. Shares SKILL-INDEX.md with hub.*
