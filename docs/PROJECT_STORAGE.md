# Project storage

Machine-bound activation is described in [Licensing](LICENSING.md). Activation
records are in a separate `licenses.sqlite` database; expiration never deletes projects.

Requires Node.js 24 or later for the current Express backend (`node:sqlite`).
The frontend project API and plan JSON shape are unchanged. The schema uses
ordinary SQLite and is readable from Rust. [Windows installer](WINDOWS_INSTALLER.md)
describes Tauri packaging and the installed application's data directory.

## Tables

| Table | Contents and relationships |
| --- | --- |
| `projects` | Primary key `id`, name, creation/update timestamps, cached floor/room counts. Indexed by update time for project listings. |
| `project_plans` | One JSON plan per project, with a plan schema version. `project_id` references `projects.id` with cascading deletion. |
| `simulation_runs` | Current saved job references by project and result slot, including every optimization band. Composite primary key `(project_id, slot, job_id)` and an index on job ID. `project_id` references `projects.id` with cascading deletion. This is a reference registry, not job execution history. |
| `storage_metadata` | One-time legacy import marker. SQLite `user_version` tracks the database schema. |

Floors, rooms, walls, APs, preferences, images, logs, and other existing plan
fields remain in `plan_json`. Foreign keys protect table relationships, not IDs
inside that JSON. Large simulation outputs remain in the simulation directory.
No unused asset table is introduced: existing assets remain in the plan or in
their existing file storage.

## Migration and saving

The API initializes `data/projects.sqlite` before accepting requests. On first
initialization it imports all records from `data/projects.json` in a single
transaction, preserving IDs, timestamps, complete plans, and saved job references.
The original JSON is left unchanged as a migration backup. Invalid JSON, invalid
plans, or duplicate IDs abort the import; correct the source and restart to retry.
The import marker is committed with the records so restarts cannot duplicate or
resurrect deleted projects. After migration, JSON is no longer updated.

Stop any older API/simulation processes before switching versions, then restart
both services. Older running processes would continue using the stale JSON.
The Rust simulation service reads saved job IDs from SQLite after migration and
uses legacy JSON only when no database exists. If references cannot be read, it
skips orphan cleanup instead of deleting potentially saved results.

Each save updates only its project, plan, and current result references in one
transaction. WAL mode permits concurrent readers; foreign keys, full synchronous
commits, and a five-second busy timeout are enabled. Simultaneous editors of the
same project still use last-write-wins semantics. Autosave still requires waiting
for **Saved** before closing.

## Paths and backups

Development defaults to the repository's `data` directory. Set `INDOOR_DATA_DIR`
to the same absolute writable directory for both services to relocate project
storage, sessions, floor-plan imports, and the default simulations directory.
`SIM_DATA_DIR` and the existing Rust `PROJECTS_FILE` override remain supported;
the service locates `projects.sqlite` beside `PROJECTS_FILE`.

For a future installed Tauri app, have the launcher resolve a per-user application
data directory and pass it to both services. Move existing data to that directory
before switching; selecting an empty directory creates an empty project library.
The Node API loads `.env` at startup; the Rust service needs environment variables
provided by its launcher/shell.

For a consistent manual backup, stop both services and copy the entire data
directory, including simulation outputs (and any separately configured output
directory). Do not copy only the main SQLite file while the app is running:
committed data may still be in its WAL file. For live backups use SQLite's backup
API. Scheduled backups and a user-facing export/import flow are not implemented
by this storage migration.
