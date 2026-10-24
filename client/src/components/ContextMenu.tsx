import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
}: {
  x: number;
  y: number;
  icons?: ContextIcon[];
  items: (ContextItem | 'sep')[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }, [x, y, icons, items]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (panel.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const close = () => onClose();
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
  }, [onClose]);

  if (!icons?.length && !items.length) return null;

  return createPortal(
    <div ref={panel} className="ctx" style={{ left: x, top: y }} role="menu" onContextMenu={(event) => event.preventDefault()}>
      {icons && icons.length > 0 && (
        <div className="ctx-icons">
          {icons.map((icon) => (
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
      {items.map((item, index) =>
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
