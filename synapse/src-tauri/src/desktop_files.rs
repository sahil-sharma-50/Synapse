use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Folder,
}

pub struct SearchQuery {
    pub name: String,
    pub kind: Option<EntryKind>,
    pub extension: Option<String>,
}
#[derive(Clone, Debug)]
pub struct SearchHit {
    pub path: PathBuf,
    pub kind: EntryKind,
    pub exact: bool,
}
pub struct SearchReport {
    pub hits: Vec<SearchHit>,
    pub roots: Vec<PathBuf>,
    pub partial: bool,
    pub issues: Vec<String>,
}
pub struct SearchLimits {
    pub entries: usize,
    pub depth: usize,
    pub budget: Duration,
    pub results: usize,
}
impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            entries: 20_000,
            depth: 12,
            budget: Duration::from_secs(2),
            results: 5,
        }
    }
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

pub fn validate_local_path(path: &Path) -> Result<PathBuf, String> {
    fn local(path: &Path) -> bool {
        let value = path.as_os_str().to_string_lossy();
        let value = value.strip_prefix(r"\\?\").unwrap_or(&value);
        let bytes = value.as_bytes();
        bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/')
            && !value[2..].contains([':', '\0'])
    }
    if !local(path) {
        return Err("Use an absolute local drive path, not a URL, network location, or device path.".into());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "The local path no longer exists or cannot be accessed.")?;
    if !local(&path) {
        return Err("This path redirects outside a local drive.".into());
    }
    Ok(path)
}

pub fn search(
    query: &SearchQuery,
    roots: &[PathBuf],
    limits: SearchLimits,
    cancelled: &dyn Fn() -> bool,
) -> Result<SearchReport, String> {
    let name = query.name.trim().to_lowercase();
    if name.is_empty() || query.name.trim().encode_utf16().count() > 255 || name.contains(['/', '\\', '\0']) {
        return Err("Search with a file or folder name and a separate location.".into());
    }
    if cancelled() {
        return Err("Task stopped".into());
    }
    let start = Instant::now();
    let mut report = SearchReport {
        hits: vec![],
        roots: vec![],
        partial: false,
        issues: vec![],
    };
    for root in roots {
        match validate_local_path(root) {
            Ok(path) if path.is_dir() => {
                if !report.roots.iter().any(|r| path_key(r) == path_key(&path)) {
                    report.roots.push(path);
                }
            }
            _ => {
                report.partial = true;
                if report.issues.len() < 10 {
                    report.issues.push(format!("Could not search {}", root.display()));
                }
            }
        }
    }
    if report.roots.is_empty() {
        return Err("No accessible local search folder. Specify a local folder path.".into());
    }
    // Keep nested roots: their shallower traversal can reach files the parent's depth budget cannot.
    let mut queue: std::collections::VecDeque<_> = report.roots.iter().cloned().map(|p| (p, 0)).collect();
    let mut visited = HashSet::new();
    let mut hits = HashSet::new();
    let mut count = 0;
    while let Some((folder, depth)) = queue.pop_front() {
        if cancelled() {
            return Err("Task stopped".into());
        }
        if start.elapsed() >= limits.budget || count >= limits.entries {
            report.partial = true;
            break;
        }
        if !visited.insert(path_key(&folder)) {
            continue;
        }
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(_) => {
                report.partial = true;
                if report.issues.len() < 10 {
                    report.issues.push(format!("Could not read {}", folder.display()));
                }
                continue;
            }
        };
        let mut batch = vec![];
        for entry in entries {
            if cancelled() {
                return Err("Task stopped".into());
            }
            if start.elapsed() >= limits.budget || count >= limits.entries {
                report.partial = true;
                break;
            }
            count += 1;
            match entry {
                Ok(entry) => batch.push(entry),
                Err(_) => report.partial = true,
            }
        }
        batch.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
        for entry in batch {
            if cancelled() {
                return Err("Task stopped".into());
            }
            if start.elapsed() >= limits.budget {
                report.partial = true;
                break;
            }
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                report.partial = true;
                continue;
            };
            let entry_name = entry.file_name().to_string_lossy().to_lowercase();
            let excluded = meta.file_type().is_symlink()
                || (meta.is_dir()
                    && (meta.file_attributes() & (0x400 | 0x2 | 0x4) != 0
                        || matches!(
                            entry_name.as_str(),
                            ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".cache"
                        )));
            if excluded {
                report.partial = true;
                continue;
            }
            let kind = if meta.is_dir() {
                EntryKind::Folder
            } else if meta.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
            let exact = entry_name == name || (query.extension.is_none() && stem == name);
            let matched = exact || name.split_whitespace().all(|word| entry_name.contains(word));
            let extension_matches = query.extension.as_ref().is_none_or(|ext| {
                path.extension().is_some_and(|actual| {
                    actual
                        .to_string_lossy()
                        .eq_ignore_ascii_case(ext.trim_start_matches('.'))
                })
            });
            if matched
                && query.kind.is_none_or(|requested| requested == kind)
                && extension_matches
                && hits.insert(path_key(&path))
            {
                match validate_local_path(&path) {
                    Ok(path) => report.hits.push(SearchHit { path, kind, exact }),
                    Err(_) => report.partial = true,
                }
            }
            if meta.is_dir() {
                if depth < limits.depth {
                    queue.push_back((path, depth + 1));
                } else {
                    report.partial = true;
                }
            }
        }
    }
    report.hits.sort_by_key(|hit| (!hit.exact, path_key(&hit.path)));
    if report.hits.len() > limits.results {
        report.partial = true;
        report.hits.truncate(limits.results);
    }
    if report.partial && report.issues.len() < 10 {
        report.issues.push(
            "Coverage is partial: excluded locations, inaccessible entries, or search limits may hide other matches."
                .into(),
        );
    }
    Ok(report)
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenPolicy {
    Document,
    Review,
}
pub fn open_policy(path: &Path) -> OpenPolicy {
    if path.is_dir()
        || path.extension().is_some_and(|extension| {
            matches!(
                extension.to_string_lossy().to_lowercase().as_str(),
                "txt"
                    | "md"
                    | "pdf"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "bmp"
                    | "webp"
                    | "csv"
                    | "docx"
                    | "xlsx"
                    | "pptx"
                    | "odt"
                    | "ods"
                    | "odp"
            )
        })
    {
        OpenPolicy::Document
    } else {
        OpenPolicy::Review
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("synapse-search-{}", crate::ids::new_id()));
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a/Budget.xlsx"), "a").unwrap();
        std::fs::write(root.join("b/Budget.xlsx"), "b").unwrap();
        std::fs::write(root.join("a/Grüße.txt"), "hello").unwrap();
        root
    }
    fn query(name: &str) -> SearchQuery {
        SearchQuery {
            name: name.into(),
            kind: None,
            extension: None,
        }
    }
    #[test]
    fn search_accepts_long_valid_unicode_names() {
        let root = fixture();
        let name = format!("{}.txt", "\u{5831}".repeat(100));
        std::fs::write(root.join(&name), "fixture").unwrap();
        let result = search(
            &query(&name),
            std::slice::from_ref(&root),
            SearchLimits::default(),
            &|| false,
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(result.unwrap().hits.len(), 1);
    }
    #[test]
    fn search_keeps_duplicate_names_and_deduplicates_overlapping_roots() {
        let root = fixture();
        let report = search(
            &query("BUDGET"),
            &[root.clone(), root.join("a")],
            SearchLimits::default(),
            &|| false,
        )
        .unwrap();
        assert_eq!(report.hits.len(), 2);
        assert!(report.hits.iter().all(|h| h.exact));
        assert_ne!(report.hits[0].path, report.hits[1].path);
        assert_eq!(
            search(
                &query("grüße"),
                std::slice::from_ref(&root),
                SearchLimits::default(),
                &|| false
            )
            .unwrap()
            .hits
            .len(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn search_reports_limits_and_access_gaps_and_honors_cancellation() {
        let root = fixture();
        let report = search(
            &query("budget"),
            &[root.clone(), root.join("missing")],
            SearchLimits::default(),
            &|| false,
        )
        .unwrap();
        assert!(report.partial);
        assert!(!report.issues.is_empty());
        for limits in [
            SearchLimits {
                entries: 1,
                ..SearchLimits::default()
            },
            SearchLimits {
                depth: 0,
                ..SearchLimits::default()
            },
            SearchLimits {
                budget: Duration::ZERO,
                ..SearchLimits::default()
            },
        ] {
            assert!(
                search(&query("budget"), std::slice::from_ref(&root), limits, &|| false)
                    .unwrap()
                    .partial
            );
        }
        assert!(search(
            &query("budget"),
            std::slice::from_ref(&root),
            SearchLimits::default(),
            &|| true
        )
        .is_err());
        assert!(search(
            &query(""),
            std::slice::from_ref(&root),
            SearchLimits::default(),
            &|| false
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn path_validation_rejects_network_devices_streams_and_missing_files() {
        for path in [
            r"C:relative.txt",
            r"\\server\share\file",
            r"\\.\pipe\test",
            r"https://example.com",
            "C:\\file\0.txt",
            r"C:\file.txt:payload",
        ] {
            assert!(validate_local_path(Path::new(path)).is_err(), "{path}");
        }
        let root = fixture();
        assert!(validate_local_path(&root.join("a/Grüße.txt")).is_ok());
        std::fs::remove_file(root.join("a/Grüße.txt")).unwrap();
        assert!(validate_local_path(&root.join("a/Grüße.txt")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn search_skips_reparse_directories_and_caches_and_bounds_results() {
        let root = fixture();
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/Budget.xlsx"), "skip").unwrap();
        let link = root.join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(root.join("a"))
            .output()
            .unwrap();
        assert!(status.status.success());
        let report = search(
            &query("budget"),
            std::slice::from_ref(&root),
            SearchLimits {
                results: 1,
                ..SearchLimits::default()
            },
            &|| false,
        )
        .unwrap();
        assert_eq!(report.hits.len(), 1);
        assert!(report.partial);
        assert!(!report.hits[0].path.to_string_lossy().contains("node_modules"));
        std::fs::remove_dir(&link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn path_policy_uses_final_extension_and_reviews_unknown_types() {
        assert_eq!(open_policy(Path::new("report.PDF")), OpenPolicy::Document);
        for name in ["report.pdf.exe", "file.lnk", "file.cmd", "macro.xlsm", "file.unknown"] {
            assert_eq!(open_policy(Path::new(name)), OpenPolicy::Review);
        }
    }
}
