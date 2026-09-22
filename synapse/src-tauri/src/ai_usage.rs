use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;

#[derive(Serialize)]
pub struct Usage {
    day: String,
    provider: String,
    model: String,
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    cost: f64,
    uncertain: i64,
}

pub fn list(db: &Connection) -> Result<Vec<Usage>, String> {
    let mut query = db
        .prepare(
            "SELECT day, provider, model, COUNT(*), SUM(input_tokens),
        SUM(output_tokens), SUM(cost), SUM(status != 'reported') FROM ai_usage
        WHERE day >= ?1 GROUP BY day, provider, model ORDER BY day",
        )
        .map_err(|e| e.to_string())?;
    let from = (chrono::Local::now().date_naive() - chrono::Duration::days(30)).to_string();
    let rows = query
        .query_map([from], |row| {
            Ok(Usage {
                day: row.get(0)?,
                provider: row.get(1)?,
                model: row.get(2)?,
                requests: row.get(3)?,
                input_tokens: row.get(4)?,
                output_tokens: row.get(5)?,
                cost: row.get(6)?,
                uncertain: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// An atomic reservation prevents overlapping interrupted requests exceeding the daily allowance.
// Unknown/failed response charges remain reserved, including after a restart.
fn reserve(db: &Connection, provider: &str, model: &str, limit: f64, ceiling: f64) -> Result<i64, String> {
    if !limit.is_finite() || !ceiling.is_finite() || ceiling < 0.0 || limit <= 0.0 {
        return Err("Invalid AI budget".into());
    }
    let day = chrono::Local::now().date_naive().to_string();
    let inserted = db
        .execute(
            "INSERT INTO ai_usage (created_at,day,provider,model,cost,status)
        SELECT ?1,?2,?3,?4,?5,'reserved' WHERE
        COALESCE((SELECT SUM(cost) FROM ai_usage WHERE day=?2),0)+?5 <= ?6",
            params![crate::ids::now_ms(), day, provider, model, ceiling, limit],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 0 {
        return Err("Daily AI limit reached. Adjust the limit in Settings > Usage or try tomorrow.".into());
    }
    Ok(db.last_insert_rowid())
}

pub struct Meter {
    db: Connection,
    id: i64,
    rates: (f64, f64),
    app: tauri::AppHandle,
}

impl Meter {
    pub fn begin(
        app: &tauri::AppHandle,
        provider: &str,
        model: &str,
        input_bytes: usize,
        max_output: u64,
        image: bool,
    ) -> Result<Self, String> {
        let rates = pricing(model)?;
        // UTF-8 bytes bound text tokens; reserve extra for protocol overhead and a vision frame.
        let ceiling = ((input_bytes + 4096) as f64 + if image { 32000.0 } else { 0.0 })
            * rates.0
            * if provider == "anthropic" { 2.0 } else { 1.0 }
            + max_output as f64 * rates.1;
        let db = crate::storage::open(&crate::storage::app_path(app)?)?;
        let limit = crate::settings::load(&crate::settings_path(app)?).ai.daily_budget;
        let id = reserve(&db, provider, model, limit, ceiling)?;
        let _ = app.emit("ai-usage-changed", ());
        Ok(Self {
            db,
            id,
            rates,
            app: app.clone(),
        })
    }

    pub fn settle(&self, usage: &Value, model: Option<&str>, request_id: Option<&str>) -> Result<(), String> {
        let input = usage["prompt_tokens"]
            .as_u64()
            .or_else(|| usage["input_tokens"].as_u64());
        let output = usage["completion_tokens"]
            .as_u64()
            .or_else(|| usage["output_tokens"].as_u64());
        let reported = usage["cost"].as_f64().filter(|n| n.is_finite() && *n >= 0.0);
        let cached_read = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        let cached_write = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        let cost = reported.or_else(|| {
            Some(
                (input? as f64 + cached_read as f64 * 0.1 + cached_write as f64 * 2.0) * self.rates.0
                    + output? as f64 * self.rates.1,
            )
        });
        let Some(cost) = cost else {
            return Ok(());
        };
        self.db
            .execute(
                "UPDATE ai_usage SET model=COALESCE(?2,model), input_tokens=?3,output_tokens=?4,
            cost=?5,status=?6,request_id=COALESCE(?7,request_id) WHERE id=?1",
                params![
                    self.id,
                    model,
                    input
                        .unwrap_or(0)
                        .saturating_add(cached_read)
                        .saturating_add(cached_write)
                        .min(i64::MAX as u64) as i64,
                    output.unwrap_or(0).min(i64::MAX as u64) as i64,
                    cost,
                    if reported.is_some() { "reported" } else { "estimated" },
                    request_id
                ],
            )
            .map_err(|e| e.to_string())?;
        let _ = self.app.emit("ai-usage-changed", ());
        Ok(())
    }

    pub fn rejected(&self) -> Result<(), String> {
        self.settle(
            &serde_json::json!({"cost":0,"input_tokens":0,"output_tokens":0}),
            None,
            None,
        )
    }
}

fn pricing(model: &str) -> Result<(f64, f64), String> {
    use std::sync::{Mutex, OnceLock};
    static PRICES: OnceLock<Mutex<Option<(std::time::Instant, Value)>>> = OnceLock::new();
    let mut cache = PRICES
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?;
    if cache.as_ref().is_none_or(|(time, _)| time.elapsed().as_secs() > 900) {
        let data = reqwest::blocking::Client::new()
            .get("https://openrouter.ai/api/v1/models")
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json::<Value>())
            .map_err(|e| format!("Could not verify model pricing: {e}"))?;
        *cache = Some((std::time::Instant::now(), data));
    }
    let data = &cache.as_ref().unwrap().1;
    let target = model.trim_start_matches('~');
    let entry = data["data"].as_array().and_then(|models| {
        models.iter().find(|m| {
            let id = m["id"].as_str().unwrap_or_default();
            id == target
                || id.split_once('/').is_some_and(|(_, short)| short == target)
                || (target == "typesafe/jev-latest" && id.starts_with("typesafe/jev-1.13"))
        })
    });
    let rate = |key: &str| {
        entry
            .and_then(|m| m["pricing"][key].as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    match (rate("prompt"), rate("completion")) {
        (Some(input), Some(output)) => Ok((input, output)),
        // Jev's alpha endpoint is absent from some catalog responses. Verified vendor list price,
        // 2026-09-22; provider-reported cost replaces this reservation after each decision.
        _ if target == "typesafe/jev-latest" => Ok((0.000000042, 0.0)),
        _ => Err(format!(
            "No verifiable price for {model}. Choose a listed model to enforce your budget."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn budget_includes_pending_calls_and_resets_by_local_day() {
        let db = Connection::open_in_memory().unwrap();
        crate::storage::initialize(&db).unwrap();
        reserve(&db, "openrouter", "jev", 1.0, 0.7).unwrap();
        assert!(reserve(&db, "openai", "mini", 1.0, 0.4).is_err());
        reserve(&db, "openai", "mini", 1.0, 0.3).unwrap();
        assert!(reserve(&db, "openai", "mini", 1.0, 0.01).is_err());
        db.execute("UPDATE ai_usage SET day='2000-01-01'", []).unwrap();
        reserve(&db, "openai", "mini", 1.0, 1.0).unwrap();
        assert!(reserve(&db, "openai", "mini", f64::NAN, 0.0).is_err());
    }
}
