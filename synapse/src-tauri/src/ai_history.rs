use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize)]
pub struct Message {
    id: i64,
    conversation: String,
    role: String,
    content: String,
    model: String,
    created_at: i64,
    status: String,
}

pub fn insert(db: &Connection, conversation: &str, role: &str, text: &str, model: &str) -> Result<i64, String> {
    db.execute(
        "INSERT INTO ai_messages (conversation, role, content, model, created_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            conversation,
            role,
            text,
            model,
            crate::ids::now_ms(),
            if role == "user" { "complete" } else { "pending" }
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(db.last_insert_rowid())
}

pub fn update(db: &Connection, id: i64, text: &str, status: &str) -> Result<(), String> {
    db.execute(
        "UPDATE ai_messages SET content = ?2, status = ?3 WHERE id = ?1",
        params![id, text, status],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn finish(db: &Connection, id: i64, status: &str) -> Result<(), String> {
    db.execute("UPDATE ai_messages SET status = ?2 WHERE id = ?1", params![id, status])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list(db: &Connection, before: Option<i64>) -> Result<Vec<Message>, String> {
    let mut query = db
        .prepare(
            "SELECT id, conversation, role, content, model, created_at, status
        FROM ai_messages WHERE id < ?1 ORDER BY id DESC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([before.unwrap_or(i64::MAX)], |row| {
            Ok(Message {
                id: row.get(0)?,
                conversation: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                model: row.get(4)?,
                created_at: row.get(5)?,
                status: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_full_history_and_interrupted_partial_replies_across_reopen() {
        let path = std::env::temp_dir().join(format!("synapse-ai-{}.db", crate::ids::new_id()));
        {
            let db = crate::storage::open(&path).unwrap();
            for _ in 0..105 {
                insert(&db, "session1", "user", "my words", "gpt-4o-mini").unwrap();
            }
            let reply = insert(&db, "session1", "assistant", "", "gpt-4o-mini").unwrap();
            update(&db, reply, "Part of an answer", "pending").unwrap();
            finish(&db, reply, "interrupted").unwrap();
        }
        {
            let db = crate::storage::open(&path).unwrap();
            let page = list(&db, None).unwrap();
            assert_eq!(page.len(), 100);
            assert_eq!(page[0].content, "Part of an answer");
            assert_eq!(page[0].status, "interrupted");
            let older = list(&db, Some(page.last().unwrap().id)).unwrap();
            assert_eq!(older.len(), 6);
            assert!(older.iter().all(|message| message.content == "my words"));
        }
        std::fs::remove_file(path).unwrap();
    }
}
