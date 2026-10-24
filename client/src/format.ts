export function formatBytes(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const digits = n >= 10 ? 0 : 1;
  return `${n.toFixed(digits)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(rest)}`;
  return `${minutes}:${pad(rest)}`;
}

export function formatDate(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatStamp(ms: number | null | undefined): string {
  if (ms == null) return '';
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function parentPath(value: string): string {
  const index = value.lastIndexOf('/');
  return index === -1 ? '' : value.slice(0, index);
}

export function baseName(value: string): string {
  const index = value.lastIndexOf('/');
  return index === -1 ? value : value.slice(index + 1);
}
