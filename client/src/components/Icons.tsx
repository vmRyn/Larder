export type IconName =
  | 'folder'
  | 'file'
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'archive'
  | 'link'
  | 'drive'
  | 'trash'
  | 'home'
  | 'users'
  | 'activity'
  | 'pin'
  | 'recent'
  | 'new'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'rename'
  | 'upload'
  | 'download'
  | 'back'
  | 'forward'
  | 'up'
  | 'search'
  | 'info'
  | 'terminal'
  | 'extract'
  | 'eye'
  | 'open'
  | 'properties'
  | 'restore';

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <img className="icon" src={`/icons/${name}.png`} width={size} height={size} alt="" draggable={false} />;
}

export function iconFor(name: string, kind: string, symlinkTo?: string): IconName {
  if (kind === 'dir' || symlinkTo === 'dir') return 'folder';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'ogv', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  if (ext === 'zip') return 'archive';
  if (['txt', 'md', 'json', 'js', 'ts', 'tsx', 'css', 'log', 'yml', 'yaml'].includes(ext)) return 'text';
  return 'file';
}

export function isImageName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(ext);
}

export function isAudioName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext);
}

export function isVideoName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ['mp4', 'webm', 'ogv', 'mov', 'mkv'].includes(ext);
}
