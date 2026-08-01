import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./SnippetPicker.css";

interface Snippet {
  id: string;
  name: string;
  content: string;
}

export default function SnippetPicker() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");

  function refresh() {
    invoke<Snippet[]>("list_snippets").then(setSnippets);
  }

  useEffect(refresh, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) => s.name.toLowerCase().includes(q) || s.content.toLowerCase().includes(q)
    );
  }, [snippets, query]);

  function insert(s: Snippet) {
    invoke("insert_snippet", { content: s.content });
  }

  function remove(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    invoke("delete_snippet", { id }).then(refresh);
  }

  async function submitNew() {
    if (!newName.trim() || !newContent.trim()) return;
    await invoke("add_snippet", { name: newName.trim(), content: newContent });
    setNewName("");
    setNewContent("");
    setAdding(false);
    refresh();
  }

  return (
    <div className="snippet-root">
      <div className="snippet-search-row">
        <input
          className="snippet-search"
          placeholder="Search snippets…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button className="snippet-add-btn" onClick={() => setAdding((v) => !v)}>
          {adding ? "×" : "+"}
        </button>
      </div>

      {adding && (
        <div className="snippet-new-form">
          <input
            className="snippet-input"
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <textarea
            className="snippet-textarea"
            placeholder="Content"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <button className="snippet-save-btn" onClick={submitNew}>
            Save snippet
          </button>
        </div>
      )}

      <div className="snippet-list">
        {filtered.length === 0 && (
          <div className="snippet-empty">
            {snippets.length === 0 ? "No snippets yet, click + to add one" : "No matches"}
          </div>
        )}
        {filtered.map((s) => (
          <div key={s.id} className="snippet-item" onClick={() => insert(s)}>
            <div className="snippet-item-text">
              <span className="snippet-item-name">{s.name}</span>
              <span className="snippet-item-preview">{s.content}</span>
            </div>
            <button className="snippet-delete-btn" onClick={(e) => remove(s.id, e)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
