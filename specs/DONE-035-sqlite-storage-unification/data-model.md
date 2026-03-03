# Data Model: SQLite Storage Unification

**Date**: 2026-03-02 | **Spec**: [spec.md](./spec.md)

## Overview

Two distinct storage layers exist. This feature unifies their backends per platform while preserving their separate interfaces.

### Layer 1: StorageProvider (collection-based key-value)

Used by: PiAgent, PlanningTool, conversation management, settings

**Schema** (per collection table):
```
Table: <collection_name>
├── key: TEXT PRIMARY KEY
├── value: TEXT NOT NULL (JSON)
├── created_at: INTEGER NOT NULL (ms epoch)
└── updated_at: INTEGER NOT NULL (ms epoch)
```

**Collections**: conversations, messages, memory, settings, cache, credentials, tasks, skills

### Layer 2: StorageAdapter (object-store with indexes)

Used by: CacheManager, SessionCacheManager, SchedulerStorage, SessionStorage

**Schema** (per store table — same physical schema as Layer 1):
```
Table: <store_name>
├── key: TEXT PRIMARY KEY (extracted from value via keyPath)
├── value: TEXT NOT NULL (JSON — full object including key field)
├── created_at: INTEGER NOT NULL (ms epoch)
└── updated_at: INTEGER NOT NULL (ms epoch)
```

**Stores and their keyPaths**:

| Store | keyPath | Primary Consumer |
|-------|---------|-----------------|
| cache_items | storageKey | SessionCacheManager |
| sessions | sessionId | SessionCacheManager |
| config | key | SessionCacheManager (ConfigStorage) |
| rollout_cache | key | CacheManager |
| scheduler_tasks | id | SchedulerStorage |
| agent_sessions | sessionId | SessionStorage |

## Entity Definitions

### SessionCacheEntry (store: cache_items)
```
storageKey: string (PK — format: "sessionId_taskId_turnId")
data: any (JSON)
description: string
timestamp: number (ms)
dataSize: number (bytes)
sessionId: string
taskId: string (8 chars)
turnId: string (8 chars)
customMetadata?: Record<string, any>
```

### SessionCacheMetadata (store: sessions)
```
sessionId: string (PK)
totalSize: number (bytes)
itemCount: number
quotaUsed: number (0-100)
createdAt: number (ms)
lastAccessedAt: number (ms)
```

### RolloutCacheEntry (store: rollout_cache)
```
key: string (PK)
entry: CacheEntry (nested object)
```

### SchedulerTaskRecord (store: scheduler_tasks)
```
id: string (PK — UUID)
status: 'draft' | 'scheduled' | 'missed' | 'waiting' | 'running' | 'completed' | 'failed'
input: string
scheduledTime?: number (ms)
createdAt: number (ms)
completedAt?: number (ms)
```

### PersistedSession (store: agent_sessions)
```
sessionId: string (PK)
sessionLetter: string
conversationId: string
type: 'primary' | 'scheduled'
state: SessionState
createdAt: number (ms)
lastActivityAt: number (ms)
tabId: number | null
tabGroupId: number | null
tabGroupName: string
scheduledTaskId: string | null
persistedAt: number (ms)
```

## Index Queries (used in practice)

| Query | Store | Index → Field | Pattern |
|-------|-------|--------------|---------|
| Get all cache entries for session | cache_items | by_session → sessionId | Equality |
| Get all tasks by status | scheduler_tasks | by_status → status | Equality |
| Get all sessions by type | agent_sessions | by_type → type | Equality |

SQLite equivalent: `SELECT * FROM <store> WHERE json_extract(value, '$.field') = ?`

## Platform Routing

```
Extension (Chrome):
  StorageProvider → IndexedDBStorageProvider → IndexedDB
  StorageAdapter  → IndexedDBAdapter → IndexedDB (pi_cache DB)

Desktop (Tauri):
  StorageProvider → SQLiteStorageProvider → invoke() → db_storage.rs → SQLite
  StorageAdapter  → TauriSQLiteAdapter → invoke() → db_storage.rs → SQLite (same DB)

Server (Node.js):
  StorageProvider → ServerStorageProvider → better-sqlite3 → SQLite
  StorageAdapter  → NodeSQLiteAdapter → better-sqlite3 → SQLite (same DB)
```
