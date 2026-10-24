import type { ReactNode } from 'react';

const CODE = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'json', 'py', 'go', 'rs', 'sh', 'bash', 'c', 'cpp', 'h', 'hpp', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml']);

const WORDS: Record<string, string> = {
  js: 'const let var function return if else for while class import export from new async await try catch throw typeof of in break continue switch case default this super null undefined true false',
  ts: 'const let var function return if else for while class import export from new async await try catch throw typeof of in break continue switch case default this super null undefined true false type interface extends implements public private protected readonly as enum namespace declare abstract',
  py: 'def class return if elif else for while import from as try except finally raise with pass break continue lambda yield True False None and or not in is',
  go: 'func return if else for range switch case default import package var const type struct interface go defer select break continue nil true false',
  rs: 'fn let mut const return if else for while loop match use mod pub struct enum impl trait where break continue self Self true false',
  sh: 'if then else elif fi for while do done case esac function return in',
  c: 'if else for while do switch case default break continue return struct enum typedef sizeof const static void int char long short float double unsigned signed include define',
  css: 'important',
  json: 'true false null',
  html: 'html head body div span script style href src class id',
  yaml: 'true false null',
  toml: 'true false',
  xml: 'xml',
};

export function isCodeName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return CODE.has(ext);
}

export function Highlight({ text, ext }: { text: string; ext: string }) {
  return <>{paint(text, ext)}</>;
}

function language(ext: string): string {
  if (ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'js';
  if (ext === 'tsx') return 'ts';
  if (ext === 'htm') return 'html';
  if (ext === 'hpp' || ext === 'cpp') return 'c';
  if (ext === 'bash') return 'sh';
  if (ext === 'yml') return 'yaml';
  return WORDS[ext] ? ext : 'js';
}

function paint(text: string, ext: string): ReactNode[] {
  const keys = new Set((WORDS[language(ext)] ?? '').split(' '));
  const hash = ext === 'py' || ext === 'sh' || ext === 'bash' || ext === 'yaml' || ext === 'yml' || ext === 'toml';
  const pattern = hash
    ? /#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w]*\b/gm
    : /\/\/.*$|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w]*\b/gm;
  const parts: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const token = match[0];
    const kind = token.startsWith('//') || token.startsWith('/*') || token.startsWith('#') || token.startsWith('"""') || token.startsWith("'''") || token.startsWith('<!--')
      ? 'comment'
      : token.startsWith('"') || token.startsWith("'") || token.startsWith('`')
        ? 'string'
        : /^\d/.test(token)
          ? 'number'
          : keys.has(token)
            ? 'keyword'
            : '';
    const className = kind === 'comment' ? 'text-muted' : kind === 'string' ? 'text-[#ce9178]' : kind === 'keyword' ? 'text-accent' : kind === 'number' ? 'text-[#b5cea8]' : '';
    parts.push(className ? <span key={index} className={className}>{token}</span> : token);
    index += 1;
    last = start + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
