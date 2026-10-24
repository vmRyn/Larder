import { useEffect, useRef, type ReactNode } from 'react';
import { usePresence } from '../motion';

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  open = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  open?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const view = useRef({ title, children, wide });
  if (open) view.current = { title, children, wide };
  const { present, phase } = usePresence(open, 180);

  useEffect(() => {
    if (!open || phase !== 'in') return;
    panel.current?.querySelector<HTMLElement>('input, button, textarea')?.focus();
  }, [open, phase]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!present) return null;
  const shown = view.current;

  return (
    <div
      className="dialog-shade fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-4"
      data-phase={phase}
      onMouseDown={() => {
        if (phase === 'in') closeRef.current();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={shown.title}
        className={`dialog-panel w-full rounded-control border border-split bg-surface p-4 shadow-[var(--shadow-pop)] ${shown.wide ? 'max-w-lg' : 'max-w-md'}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="mb-3 text-base">{shown.title}</h2>
        {shown.children}
      </div>
    </div>
  );
}
