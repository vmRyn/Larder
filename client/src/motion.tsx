import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function usePresence(open: boolean, ms = 160) {
  const reduced = useReducedMotion();
  const duration = reduced ? 0 : ms;
  const [present, setPresent] = useState(open);
  const [phase, setPhase] = useState<'in' | 'out'>(open && reduced ? 'in' : 'out');

  if (open && !present) setPresent(true);

  useEffect(() => {
    if (!present) return;
    if (open) {
      if (duration === 0) {
        setPhase('in');
        return;
      }
      const id = requestAnimationFrame(() => setPhase('in'));
      return () => cancelAnimationFrame(id);
    }
    setPhase('out');
    const timer = window.setTimeout(() => setPresent(false), duration);
    return () => window.clearTimeout(timer);
  }, [open, present, duration]);

  return { present, phase };
}

export function Presence({
  open,
  className,
  children,
  ms = 160,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
  ms?: number;
}) {
  const { present, phase } = usePresence(open, ms);
  if (!present) return null;
  return (
    <div className={className} data-phase={phase}>
      {children}
    </div>
  );
}

export function NavRail({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    const indicator = mark.current;
    if (!root || !indicator) return;
    const active = root.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) {
      indicator.dataset.show = 'false';
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    const shown = indicator.dataset.show === 'true';
    if (!shown) indicator.dataset.instant = 'true';
    indicator.style.width = `${rect.width}px`;
    indicator.style.height = `${rect.height}px`;
    indicator.style.transform = `translate(${rect.left - rootRect.left + root.scrollLeft}px, ${rect.top - rootRect.top + root.scrollTop}px)`;
    indicator.dataset.show = 'true';
    if (!shown) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (mark.current?.dataset.show === 'true') mark.current.dataset.instant = 'false';
        });
      });
    }
  });

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      const indicator = mark.current;
      const active = root.querySelector<HTMLElement>('[data-active="true"]');
      if (!indicator || !active) return;
      const rootRect = root.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      indicator.style.width = `${rect.width}px`;
      indicator.style.height = `${rect.height}px`;
      indicator.style.transform = `translate(${rect.left - rootRect.left + root.scrollLeft}px, ${rect.top - rootRect.top + root.scrollTop}px)`;
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`nav-rail ${className ?? ''}`}>
      <span ref={mark} className="nav-indicator" data-show="false" data-instant="true" aria-hidden="true" />
      {children}
    </div>
  );
}
