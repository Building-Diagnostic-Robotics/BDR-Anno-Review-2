use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager};

pub const JOB_STATUS_QUEUED: &str = "queued";
pub const JOB_STATUS_IN_PROGRESS: &str = "in_progress";
pub const JOB_STATUS_DONE: &str = "done";
pub const JOB_STATUS_FAILED: &str = "failed";
pub const JOB_STATUS_CANCELLED: &str = "cancelled";

pub const SUGGESTION_STATUS_READY: &str = "ready";
pub const SUGGESTION_STATUS_FAILED: &str = "failed";
#[derive(Debug, Clone)]
pub struct ReadinessSnapshot {
    pub ready_count: usize,
    pub queued_count: usize,
    pub in_progress_count: usize,
    pub failed_count: usize,
}

#[derive(Debug, Clone)]
pub struct JobInsert {
    pub job_id: String,
    pub dataset_id: String,
    pub frame_id: String,
    pub suggestion_signature: String,
    pub priority: i64,
}

#[derive(Debug, Clone)]
pub struct LeasedJob {
    pub job_id: String,
    pub dataset_id: String,
    pub frame_id: String,
    pub suggestion_signature: String,
}

fn unix_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|source| format!("failed to resolve app local data dir: {source}"))?;
    fs::create_dir_all(&base).map_err(|source| {
        format!(
            "failed to create local data directory `{}`: {source}",
            base.display()
        )
    })?;
    Ok(base.join("suggestions.sqlite3"))
}

fn open_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let connection = Connection::open(path.as_path()).map_err(|source| {
        format!(
            "failed to open suggestions database `{}`: {source}",
            path.display()
        )
    })?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|source| format!("failed to configure suggestions database pragmas: {source}"))?;
    Ok(connection)
}

fn ensure_schema_on_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS suggestions (
            dataset_id TEXT NOT NULL,
            frame_id TEXT NOT NULL,
            suggestion_signature TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('ready', 'failed', 'stale')),
            payload TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_suggestions_dataset_frame_signature
        ON suggestions(dataset_id, frame_id, suggestion_signature);

        CREATE TABLE IF NOT EXISTS suggestion_jobs (
            job_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            frame_id TEXT NOT NULL,
            suggestion_signature TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'in_progress', 'done', 'failed', 'cancelled')),
            priority INTEGER NOT NULL DEFAULT 0,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            lease_expires_at INTEGER,
            error_code TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_suggestion_jobs_dataset_signature
        ON suggestion_jobs(dataset_id, suggestion_signature, frame_id, status);

        CREATE UNIQUE INDEX IF NOT EXISTS uq_suggestion_jobs_active
        ON suggestion_jobs(dataset_id, frame_id, suggestion_signature)
        WHERE status IN ('queued', 'in_progress');
        "#,
    )
    .map_err(|source| format!("failed to create suggestions schema: {source}"))?;
    Ok(())
}

pub fn ensure_schema(app: &AppHandle) -> Result<(), String> {
    let conn = open_connection(app)?;
    ensure_schema_on_connection(&conn)
}

pub fn has_ready_suggestion(
    app: &AppHandle,
    dataset_id: &str,
    frame_id: &str,
    suggestion_signature: &str,
) -> Result<bool, String> {
    let conn = open_connection(app)?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM suggestions WHERE dataset_id = ?1 AND frame_id = ?2 AND suggestion_signature = ?3 AND status = 'ready'",
            params![dataset_id, frame_id, suggestion_signature],
            |row| row.get(0),
        )
        .map_err(|source| format!("failed to query ready suggestions: {source}"))?;
    Ok(count > 0)
}

pub fn has_active_job(
    app: &AppHandle,
    dataset_id: &str,
    frame_id: &str,
    suggestion_signature: &str,
) -> Result<bool, String> {
    let conn = open_connection(app)?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM suggestion_jobs WHERE dataset_id = ?1 AND frame_id = ?2 AND suggestion_signature = ?3 AND status IN ('queued', 'in_progress')",
            params![dataset_id, frame_id, suggestion_signature],
            |row| row.get(0),
        )
        .map_err(|source| format!("failed to query active suggestion jobs: {source}"))?;
    Ok(count > 0)
}

fn load_ready_suggestion_on_connection<T: DeserializeOwned>(
    conn: &Connection,
    dataset_id: &str,
    frame_id: &str,
    suggestion_signature: &str,
) -> Result<Option<T>, String> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload FROM suggestions WHERE dataset_id = ?1 AND frame_id = ?2 AND suggestion_signature = ?3 AND status = 'ready'",
            params![dataset_id, frame_id, suggestion_signature],
            |row| row.get(0),
        )
        .optional()
        .map_err(|source| format!("failed to load ready suggestion payload: {source}"))?;

    match payload {
        Some(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|source| format!("failed to parse ready suggestion payload: {source}")),
        None => Ok(None),
    }
}

pub fn load_ready_suggestion<T: DeserializeOwned>(
    app: &AppHandle,
    dataset_id: &str,
    frame_id: &str,
    suggestion_signature: &str,
) -> Result<Option<T>, String> {
    let conn = open_connection(app)?;
    load_ready_suggestion_on_connection(&conn, dataset_id, frame_id, suggestion_signature)
}

pub fn upsert_suggestion_ready(
    app: &AppHandle,
    dataset_id: &str,
    frame_id: &str,
    suggestion_signature: &str,
    payload: &str,
) -> Result<(), String> {
    let conn = open_connection(app)?;
    let now = unix_ts();
    conn.execute(
        "INSERT INTO suggestions(dataset_id, frame_id, suggestion_signature, status, payload, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'ready', ?4, ?5, ?5)
         ON CONFLICT(dataset_id, frame_id, suggestion_signature)
         DO UPDATE SET status = 'ready', payload = excluded.payload, updated_at = excluded.updated_at",
        params![dataset_id, frame_id, suggestion_signature, payload, now],
    )
    .map_err(|source| format!("failed to upsert suggestion payload: {source}"))?;
    Ok(())
}

pub fn mark_suggestion_failed(
    app: &AppHandle,
    dataset_id: &str,
    frame_id: &str,
    suggestion_signature: &str,
) -> Result<(), String> {
    let conn = open_connection(app)?;
    let now = unix_ts();
    conn.execute(
        "INSERT INTO suggestions(dataset_id, frame_id, suggestion_signature, status, payload, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'failed', NULL, ?4, ?4)
         ON CONFLICT(dataset_id, frame_id, suggestion_signature)
         DO UPDATE SET status = 'failed', updated_at = excluded.updated_at",
        params![dataset_id, frame_id, suggestion_signature, now],
    )
    .map_err(|source| format!("failed to mark suggestion failed: {source}"))?;
    Ok(())
}

fn insert_jobs_if_missing_on_connection(
    conn: &mut Connection,
    jobs: &[JobInsert],
) -> Result<Vec<String>, String> {
    if jobs.is_empty() {
        return Ok(Vec::new());
    }
    let tx = conn
        .transaction()
        .map_err(|source| format!("failed to start suggestion job transaction: {source}"))?;
    let mut inserted = Vec::new();
    let now = unix_ts();
    for job in jobs {
        let affected = tx
            .execute(
                "INSERT OR IGNORE INTO suggestion_jobs(job_id, dataset_id, frame_id, suggestion_signature, status, priority, attempt_count, lease_expires_at, error_code, error_message, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'queued', ?5, 0, NULL, NULL, NULL, ?6, ?6)",
                params![job.job_id, job.dataset_id, job.frame_id, job.suggestion_signature, job.priority, now],
            )
            .map_err(|source| format!("failed to insert suggestion job: {source}"))?;
        if affected > 0 {
            inserted.push(job.frame_id.clone());
        }
    }
    tx.commit()
        .map_err(|source| format!("failed to commit suggestion job transaction: {source}"))?;
    Ok(inserted)
}

pub fn insert_jobs_if_missing(app: &AppHandle, jobs: &[JobInsert]) -> Result<Vec<String>, String> {
    let mut conn = open_connection(app)?;
    insert_jobs_if_missing_on_connection(&mut conn, jobs)
}

pub fn lease_next_job(app: &AppHandle, lease_seconds: i64) -> Result<Option<LeasedJob>, String> {
    let mut conn = open_connection(app)?;
    let tx = conn
        .transaction()
        .map_err(|source| format!("failed to begin lease transaction: {source}"))?;
    let now = unix_ts();
    let row = tx
        .query_row(
            "SELECT job_id, dataset_id, frame_id, suggestion_signature, attempt_count
             FROM suggestion_jobs
             WHERE status = 'queued'
                OR (status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1)
             ORDER BY priority DESC, created_at ASC
             LIMIT 1",
            params![now],
            |row| {
                Ok(LeasedJob {
                    job_id: row.get(0)?,
                    dataset_id: row.get(1)?,
                    frame_id: row.get(2)?,
                    suggestion_signature: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|source| format!("failed to lease next suggestion job: {source}"))?;

    let Some(job) = row else {
        tx.commit()
            .map_err(|source| format!("failed to finalize empty lease transaction: {source}"))?;
        return Ok(None);
    };

    tx.execute(
        "UPDATE suggestion_jobs
         SET status = 'in_progress', attempt_count = attempt_count + 1, lease_expires_at = ?2, updated_at = ?1, error_code = NULL, error_message = NULL
         WHERE job_id = ?3",
        params![now, now + lease_seconds, job.job_id],
    )
    .map_err(|source| format!("failed to update leased suggestion job: {source}"))?;
    tx.commit()
        .map_err(|source| format!("failed to commit lease transaction: {source}"))?;
    Ok(Some(job))
}

pub fn complete_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_connection(app)?;
    let now = unix_ts();
    conn.execute(
        "UPDATE suggestion_jobs
         SET status = ?2, updated_at = ?1, lease_expires_at = NULL, error_code = CASE WHEN ?3 IS NULL THEN NULL ELSE 'worker_error' END, error_message = ?3
         WHERE job_id = ?4",
        params![now, status, error, job_id],
    )
    .map_err(|source| format!("failed to complete suggestion job: {source}"))?;
    Ok(())
}

pub fn readiness_snapshot(
    app: &AppHandle,
    dataset_id: &str,
    candidate_frame_ids: &[String],
    signature: &str,
) -> Result<ReadinessSnapshot, String> {
    let conn = open_connection(app)?;
    readiness_snapshot_on_connection(&conn, dataset_id, candidate_frame_ids, signature)
}

fn readiness_snapshot_on_connection(
    conn: &Connection,
    dataset_id: &str,
    candidate_frame_ids: &[String],
    signature: &str,
) -> Result<ReadinessSnapshot, String> {
    if candidate_frame_ids.is_empty() {
        return Ok(ReadinessSnapshot {
            ready_count: 0,
            queued_count: 0,
            in_progress_count: 0,
            failed_count: 0,
        });
    }
    let mut ready_count = 0usize;
    let mut failed_count = 0usize;
    let mut queued_count = 0usize;
    let mut in_progress_count = 0usize;

    for frame_id in candidate_frame_ids {
        let suggestion_status: Option<String> = conn
            .query_row(
                "SELECT status FROM suggestions WHERE dataset_id = ?1 AND frame_id = ?2 AND suggestion_signature = ?3",
                params![dataset_id, frame_id, signature],
                |row| row.get(0),
            )
            .optional()
            .map_err(|source| format!("failed to read suggestion status: {source}"))?;
        match suggestion_status.as_deref() {
            Some(SUGGESTION_STATUS_READY) => ready_count += 1,
            Some(SUGGESTION_STATUS_FAILED) => failed_count += 1,
            _ => {}
        }

        let job_status: Option<String> = conn
            .query_row(
                "SELECT status FROM suggestion_jobs WHERE dataset_id = ?1 AND frame_id = ?2 AND suggestion_signature = ?3 AND status IN ('queued', 'in_progress') ORDER BY created_at DESC LIMIT 1",
                params![dataset_id, frame_id, signature],
                |row| row.get(0),
            )
            .optional()
            .map_err(|source| format!("failed to read suggestion job status: {source}"))?;
        match job_status.as_deref() {
            Some(JOB_STATUS_QUEUED) => queued_count += 1,
            Some(JOB_STATUS_IN_PROGRESS) => in_progress_count += 1,
            _ => {}
        }
    }

    Ok(ReadinessSnapshot {
        ready_count,
        queued_count,
        in_progress_count,
        failed_count,
    })
}

pub fn recently_failed(
    app: &AppHandle,
    dataset_id: &str,
    frame_id: &str,
    signature: &str,
    cooldown_seconds: i64,
) -> Result<bool, String> {
    if cooldown_seconds <= 0 {
        return Ok(false);
    }
    let conn = open_connection(app)?;
    let now = unix_ts();
    let updated_at: Option<i64> = conn
        .query_row(
            "SELECT updated_at FROM suggestions WHERE dataset_id = ?1 AND frame_id = ?2 AND suggestion_signature = ?3 AND status = 'failed'",
            params![dataset_id, frame_id, signature],
            |row| row.get(0),
        )
        .optional()
        .map_err(|source| format!("failed to inspect failed suggestion cooldown state: {source}"))?;
    Ok(updated_at
        .map(|ts| now.saturating_sub(ts) < cooldown_seconds)
        .unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_schema_on_connection, insert_jobs_if_missing_on_connection,
        load_ready_suggestion_on_connection, readiness_snapshot_on_connection, JobInsert,
    };
    use crate::llm::{SuggestionBox, SuggestionDiagnostics, SuggestionResponse};
    use rusqlite::{params, Connection};

    #[test]
    fn ready_payload_can_be_loaded_and_deserialized() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_schema_on_connection(&conn).expect("schema");
        let payload = serde_json::to_string(&SuggestionResponse {
            face_id: "face-1".to_owned(),
            provider: "openai".to_owned(),
            model: "gpt-5.4".to_owned(),
            suggestions: vec![SuggestionBox {
                bbox: [1.0, 2.0, 3.0, 4.0],
                confidence: Some(0.9),
                source: "llm".to_owned(),
            }],
            attempts: 1,
            diagnostics: Some(SuggestionDiagnostics {
                tool_enabled: true,
                output_mode: "structured_output".to_owned(),
                provider_status: "completed".to_owned(),
                provider_response_id: Some("resp_123".to_owned()),
            }),
        })
        .expect("payload");

        conn.execute(
            "INSERT INTO suggestions(dataset_id, frame_id, suggestion_signature, status, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'ready', ?4, 1, 1)",
            params!["/tmp/dataset", "face-1", "sig-1", payload],
        )
        .expect("insert payload");

        let loaded: Option<SuggestionResponse> =
            load_ready_suggestion_on_connection(&conn, "/tmp/dataset", "face-1", "sig-1")
                .expect("load ready payload");
        let loaded = loaded.expect("payload should be present");
        assert_eq!(loaded.face_id, "face-1");
        assert_eq!(loaded.provider, "openai");
        assert_eq!(loaded.suggestions.len(), 1);
        assert_eq!(loaded.suggestions[0].bbox, [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(
            loaded
                .diagnostics
                .as_ref()
                .and_then(|value| value.provider_response_id.as_deref()),
            Some("resp_123")
        );
    }

    #[test]
    fn insert_jobs_reports_only_newly_inserted_frames() {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        ensure_schema_on_connection(&conn).expect("schema");
        let jobs = vec![
            JobInsert {
                job_id: "job-1".to_owned(),
                dataset_id: "/tmp/dataset".to_owned(),
                frame_id: "face-1".to_owned(),
                suggestion_signature: "sig-1".to_owned(),
                priority: 10,
            },
            JobInsert {
                job_id: "job-2".to_owned(),
                dataset_id: "/tmp/dataset".to_owned(),
                frame_id: "face-2".to_owned(),
                suggestion_signature: "sig-1".to_owned(),
                priority: 9,
            },
        ];

        let first = insert_jobs_if_missing_on_connection(&mut conn, &jobs).expect("first insert");
        assert_eq!(first, vec!["face-1".to_owned(), "face-2".to_owned()]);

        let duplicate =
            insert_jobs_if_missing_on_connection(&mut conn, &jobs).expect("duplicate insert");
        assert!(duplicate.is_empty());
    }

    #[test]
    fn readiness_snapshot_counts_persisted_ready_payloads() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_schema_on_connection(&conn).expect("schema");
        conn.execute(
            "INSERT INTO suggestions(dataset_id, frame_id, suggestion_signature, status, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'ready', ?4, 1, 1)",
            params!["/tmp/dataset", "face-1", "sig-1", "{\"faceId\":\"face-1\",\"provider\":\"openai\",\"model\":\"gpt-5.4\",\"suggestions\":[],\"attempts\":1}"],
        )
        .expect("insert ready suggestion");

        let snapshot = readiness_snapshot_on_connection(
            &conn,
            "/tmp/dataset",
            &["face-1".to_owned()],
            "sig-1",
        )
        .expect("snapshot");
        assert_eq!(snapshot.ready_count, 1);
        assert_eq!(snapshot.queued_count, 0);
        assert_eq!(snapshot.in_progress_count, 0);
        assert_eq!(snapshot.failed_count, 0);
    }
}
