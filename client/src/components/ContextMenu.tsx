import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '../motion';
import { Icon, type IconName } from './Icons';

export type ContextIcon = {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

export type ContextItem = {
  icon: IconName;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
};

export function menuItems(groups: (ContextItem | false | null | undefined)[][]): (ContextItem | 'sep')[] {
  const items: (ContextItem | 'sep')[] = [];
  for (const group of groups) {
    const kept = group.filter((item): item is ContextItem => Boolean(item));
    if (!kept.length) continue;
    if (items.length) items.push('sep');
    items.push(...kept);
  }
  return items;
}

export function ContextMenu({
  x,
  y,
  icons,
  items,
  onClose,
  open = true,
}: {
  x: number;
  y: number;
  icons?: ContextIcon[];
  items: (ContextItem | 'sep')[];
  onClose: () => void;
  open?: boolean;
}) {
  const { present, phase } = usePresence(open, 160);
  const held = useRef({ x, y, icons, items });
  if (open) held.current = { x, y, icons, items };
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const panel = useRef<HTMLDivElement>(null);
  const view = held.current;

  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(view.x, window.innerWidth - rect.width - 8);
    const top = Math.min(view.y, window.innerHeight - rect.height - 8);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }, [present, phase, view]);

  useEffect(() => {
    if (!present) return;
    const onPointer = (event: MouseEvent) => {
      if (panel.current?.contains(event.target as Node)) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    const close = () => closeRef.current();
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [present]);

  if (!present || (!view.icons?.length && !view.items.length)) return null;

  return createPortal(
    <div ref={panel} className="ctx pop" data-phase={phase} style={{ left: view.x, top: view.y }} role="menu" onContextMenu={(event) => event.preventDefault()}>
      {view.icons && view.icons.length > 0 && (
        <div className="ctx-icons">
          {view.icons.map((icon) => (
            <button
              key={icon.label}
              className="ctx-icon"
              type="button"
              title={icon.label}
              disabled={icon.disabled}
              onClick={() => {
                if (icon.disabled) return;
                icon.onSelect();
                onClose();
              }}
            >
              <Icon name={icon.icon} size={16} />
            </button>
          ))}
        </div>
      )}
      {view.items.map((item, index) =>
        item === 'sep' ? (
          <div key={index} className="ctx-sep" />
        ) : (
          <button
            key={item.label}
            className="ctx-item"
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            <Icon name={item.icon} size={16} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="ctx-key">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
