type Entry = FileSystemEntry;
type FileEntry = FileSystemFileEntry;
type DirEntry = FileSystemDirectoryEntry;

export type Dropped = { file: File; path: string };

export type DropResult = { files: Dropped[]; directories: string[] };

function readFile(entry: FileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<Entry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: Entry, prefix: string, files: Dropped[], directories: string[]) {
  if (entry.isFile) {
    const file = await readFile(entry as FileEntry);
    files.push({ file, path: `${prefix}${file.name}` });
    return;
  }
  if (!entry.isDirectory) return;
  const base = `${prefix}${entry.name}/`;
  directories.push(base.slice(0, -1));
  const reader = (entry as DirEntry).createReader();
  const children: Entry[] = [];
  for (;;) {
    const batch = await readBatch(reader);
    if (batch.length === 0) break;
    children.push(...batch);
  }
  for (const child of children) await walk(child, base, files, directories);
}

export async function fromDataTransfer(data: DataTransfer): Promise<DropResult> {
  const entries = [...data.items].map((item) => item.webkitGetAsEntry?.() ?? null).filter((entry): entry is Entry => Boolean(entry));
  if (entries.length === 0) {
    return { files: [...data.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })), directories: [] };
  }
  const files: Dropped[] = [];
  const directories: string[] = [];
  for (const entry of entries) await walk(entry, '', files, directories);
  return { files, directories };
}
