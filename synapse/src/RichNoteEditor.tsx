import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./RichNoteEditor.css";

export interface RichNote {
  id: string;
  content: string;
  document: string;
  revision: number;
  color: string;
  favorite: boolean;
  folder: string | null;
  tags: string[];
  trashed_at: number | null;
}

type SaveState = "saved" | "saving" | "unsaved";

const TOOL_ICONS: Record<string, string> = {
  Bold: "M7 4h6a4 4 0 0 1 0 8H7m0-8v16h7a4 4 0 0 0 0-8H7",
  Italic: "M11 4h8M5 20h8M15 4 9 20",
  Underline: "M6 4v7a6 6 0 0 0 12 0V4M5 21h14",
  Strikethrough: "M17 6c-1-2-3-3-5-3-7 0-7 7-2 8m-3 7c2 4 11 4 11-2 0-2-2-3-4-3M3 12h18",
  "Bullet list": "M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1",
  "Numbered list": "M10 6h11M10 12h11M10 18h11M3 4h2v5M3 9h4M3 14c4-3 5 1 2 3l-2 3h4",
  Checklist: "M10 6h11M10 12h11M10 18h11m-18-7 2 2 3-4M3 5h3M3 18h3",
  "Code block": "m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16",
  Link: "m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  Image: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M15 8h.01",
  "Attach file": "m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2",
};
function Tool({
  label,
  active,
  disabled = false,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "rich-tool rich-tool-active" : "rich-tool"}
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {TOOL_ICONS[label] ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={TOOL_ICONS[label]} />
        </svg>
      ) : label === "Heading 1" ? (
        "H1"
      ) : label === "Heading 2" ? (
        "H2"
      ) : (
        label
      )}
    </button>
  );
}

function initialDocument(note: RichNote) {
  if (note.document) {
    try {
      return JSON.parse(note.document);
    } catch {
      /* migrate from plain text below */
    }
  }
  return note.content || "";
}

export default function RichNoteEditor({
  note,
  compact = false,
  onChanged,
}: {
  note: RichNote;
  compact?: boolean;
  onChanged?: () => void;
}) {
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState("");
  const [folder, setFolder] = useState(note.folder ?? "");
  const [tags, setTags] = useState(note.tags.join(", "));
  const revision = useRef(note.revision);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    async (document: object, plainText: string) => {
      setSaveState("saving");
      try {
        revision.current = await invoke<number>("save_note_document", {
          id: note.id,
          document: JSON.stringify(document),
          plainText,
          expectedRevision: revision.current,
        });
        setError("");
        setSaveState("saved");
        onChanged?.();
      } catch (reason) {
        setError(
          String(reason).includes("revision conflict")
            ? "This note changed in another window. Reopen it to keep editing."
            : String(reason),
        );
        setSaveState("unsaved");
      }
    },
    [note.id, onChanged],
  );

  const editor = useEditor(
    {
      shouldRerenderOnTransaction: true,
      extensions: [
        StarterKit.configure({ link: { openOnClick: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Image.configure({ allowBase64: false }),
        Placeholder.configure({ placeholder: "Start writing…" }),
        Markdown,
      ],
      content: initialDocument(note),
      editorProps: { attributes: { class: "rich-note-content", "aria-label": "Note editor" } },
      onUpdate: ({ editor: activeEditor }) => {
        setSaveState("unsaved");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          void persist(activeEditor.getJSON(), activeEditor.getText({ blockSeparator: "\n" }));
        }, 500);
      },
    },
    [note.id],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function importDocument() {
    const path = await open({
      multiple: false,
      filters: [{ name: "Notes", extensions: ["txt", "md", "markdown"] }],
    });
    if (typeof path !== "string" || !editor) return;
    const content = await invoke<string>("load_note_from", { path });
    const markdown = /\.md|\.markdown$/i.test(path);
    editor.commands.setContent(content, markdown ? { contentType: "markdown" } : undefined);
  }

  async function exportDocument(format: "md" | "html" | "txt") {
    if (!editor) return;
    const path = await save({
      defaultPath: `${editor.getText().split("\n").find(Boolean)?.slice(0, 40) || "Untitled"}.${format}`,
      filters: [
        {
          name: format === "md" ? "Markdown" : format === "html" ? "HTML" : "Plain text",
          extensions: [format],
        },
      ],
    });
    if (!path) return;
    const content =
      format === "md"
        ? editor.getMarkdown()
        : format === "html"
          ? editor.getHTML()
          : editor.getText({ blockSeparator: "\n" });
    await invoke("save_note_to", { path, content });
  }

  async function addLink() {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("Link URL", previous ?? "https://");
    if (href === null) return;
    if (!href.trim()) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  async function addImage() {
    if (!editor) return;
    const src = window.prompt("Image URL", "https://");
    if (src?.trim()) editor.chain().focus().setImage({ src: src.trim() }).run();
  }

  async function attachFile() {
    if (!editor) return;
    const path = await open({ multiple: false });
    if (typeof path !== "string") return;
    const name = path.split(/[\\/]/).pop() ?? "Attachment";
    editor
      .chain()
      .focus()
      .insertContent({
        type: "text",
        text: `📎 ${name}`,
        marks: [
          {
            type: "link",
            attrs: {
              href: path,
              target: "_blank",
              rel: "noopener noreferrer nofollow",
              class: null,
            },
          },
        ],
      })
      .run();
  }

  function saveOrganization() {
    void invoke("organize_note", {
      id: note.id,
      folder: folder.trim() || null,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
      .then(() => onChanged?.())
      .catch((reason) => setError(String(reason)));
  }

  if (!editor)
    return (
      <div className="rich-note-loading" role="status">
        Opening note…
      </div>
    );

  return (
    <section className={`rich-note${compact ? " rich-note-compact" : ""}`}>
      <div className="rich-toolbar" role="toolbar" aria-label="Text formatting">
        <Tool
          label="Heading 1"
          active={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        />
        <Tool
          label="Heading 2"
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        />
        <span className="rich-divider" />
        <Tool
          label="Bold"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
        <Tool
          label="Italic"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
        <Tool
          label="Underline"
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        />
        <Tool
          label="Strikethrough"
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        />
        <span className="rich-divider" />
        <Tool
          label="Bullet list"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        />
        <Tool
          label="Numbered list"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        />
        <Tool
          label="Checklist"
          active={editor.isActive("taskList")}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        />
        <Tool
          label="Code block"
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        />
        <Tool label="Link" active={editor.isActive("link")} onClick={() => void addLink()} />
        <Tool label="Image" onClick={() => void addImage()} />
        <Tool
          label="Attach file"
          onClick={() => void attachFile().catch((reason) => setError(String(reason)))}
        />
        <span className="rich-toolbar-spacer" />
        <Tool
          label="Import"
          onClick={() => void importDocument().catch((reason) => setError(String(reason)))}
        />
        <details className="rich-export">
          <summary aria-label="Export note">Export</summary>
          <div className="rich-export-menu">
            <button
              onClick={() => void exportDocument("md").catch((reason) => setError(String(reason)))}
            >
              Markdown
            </button>
            <button
              onClick={() =>
                void exportDocument("html").catch((reason) => setError(String(reason)))
              }
            >
              HTML
            </button>
            <button
              onClick={() => void exportDocument("txt").catch((reason) => setError(String(reason)))}
            >
              Plain text
            </button>
          </div>
        </details>
      </div>
      {!compact && (
        <div className="rich-metadata">
          <label>
            Folder
            <input
              value={folder}
              placeholder="None"
              onChange={(event) => setFolder(event.target.value)}
              onBlur={saveOrganization}
            />
          </label>
          <label>
            Tags
            <input
              value={tags}
              placeholder="work, ideas"
              onChange={(event) => setTags(event.target.value)}
              onBlur={saveOrganization}
            />
          </label>
        </div>
      )}
      {error && (
        <div className="rich-note-error" role="alert">
          {error}
        </div>
      )}
      <EditorContent editor={editor} className="rich-editor" />
      <footer className="rich-status">
        <span>
          {saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved" : "Saved"}
        </span>
        <span>
          {editor.storage.characterCount?.words?.() ??
            editor.getText().trim().split(/\s+/).filter(Boolean).length}{" "}
          words
        </span>
      </footer>
    </section>
  );
}
