import { useLayoutEffect, useRef, type ReactNode } from "react";
import { TrashIcon } from "./settings/icons";

export interface ContextMenuState {
  x: number;
  y: number;
  items: { text: string; icon?: ReactNode; danger?: boolean; action: () => void }[];
}

export default function ContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - bounds.height - 8))}px`;
    element.querySelector("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [menu]);
  return (
    <div
      className="sy-menu-backdrop"
      onPointerDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="sy-context-menu"
        ref={ref}
        role="menu"
        aria-label="Item actions"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" || event.key === "Tab") {
            event.preventDefault();
            onClose();
            return;
          }
          const buttons = Array.from(ref.current!.querySelectorAll("button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "ArrowDown"
              ? (index + 1) % buttons.length
              : event.key === "ArrowUp"
                ? (index + buttons.length - 1) % buttons.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : null;
          if (next !== null) {
            event.preventDefault();
            buttons[next].focus();
          }
        }}
      >
        {menu.items.map((item) => (
          <button
            key={item.text}
            role="menuitem"
            className={item.danger ? "sy-menu-danger" : undefined}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            <span aria-hidden="true">{item.icon || (item.danger && <TrashIcon />)}</span>
            {item.text}
          </button>
        ))}
      </div>
    </div>
  );
}
