import type { ReactNode } from "react";

export default function SelectionBar({
  selected,
  total,
  onSelectAll,
  children,
}: {
  selected: number;
  total: number;
  onSelectAll: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="sy-selection-bar">
      <label>
        <input
          type="checkbox"
          aria-label="Select all shown"
          checked={total > 0 && selected === total}
          disabled={!total}
          ref={(element) => {
            if (element) element.indeterminate = selected > 0 && selected < total;
          }}
          onChange={(event) => onSelectAll(event.target.checked)}
        />
        <span>{selected ? `${selected} selected` : "Select all"}</span>
      </label>
      {selected > 0 && <div className="sy-selection-actions">{children}</div>}
    </div>
  );
}
