/// Must stay in step with `notes::COLORS` in src-tauri/src/notes.rs — the
/// backend rejects any colour not in its own list, so an id added here alone
/// would silently fail to save.
export const NOTE_COLORS = [
  { id: "amber", label: "Amber" },
  { id: "rose", label: "Rose" },
  { id: "sky", label: "Sky" },
  { id: "mint", label: "Mint" },
  { id: "slate", label: "Slate" },
] as const;

export type NoteColor = (typeof NOTE_COLORS)[number]["id"];
