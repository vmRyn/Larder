import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = panel.current?.querySelector<HTMLElement>('input, button, textarea');
    field?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-4" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full rounded-control border border-split bg-surface p-4 shadow-[0_16px_40px_rgb(0_0_0/0.45)] ${wide ? 'max-w-lg' : 'max-w-md'}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="mb-3 text-base">{title}</h2>
        {children}
      </div>
    </div>
  );
}
