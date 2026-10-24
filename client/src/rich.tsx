import type { ReactNode } from 'react';

function inline(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = source;
  let key = 0;
  while (rest.length > 0) {
    const code = rest.match(/^`([^`]+)`/);
    const bold = rest.match(/^\*\*([^*]+)\*\*/);
    const italic = rest.match(/^\*([^*]+)\*/);
    const link = rest.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
    const match = code ?? bold ?? italic ?? link;
    if (!match) {
      const next = rest.search(/[`*\[]/);
      const end = next === -1 ? rest.length : next === 0 ? 1 : next;
      nodes.push(rest.slice(0, end));
      rest = rest.slice(end);
      continue;
    }
    if (match === code) nodes.push(<code key={key}>{match[1]}</code>);
    else if (match === bold) nodes.push(<strong key={key}>{match[1]}</strong>);
    else if (match === italic) nodes.push(<em key={key}>{match[1]}</em>);
    else nodes.push(<a key={key} href={match[2]} rel="noopener noreferrer">{match[1]}</a>);
    key += 1;
    rest = rest.slice(match[0].length);
  }
  return nodes;
}

export function MarkdownView({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(<p key={`p${blocks.length}`}>{inline(paragraph.join(' '))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(<ul key={`u${blocks.length}`} className="list-disc pl-5">{list.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>);
    list = [];
  };
  for (const line of lines) {
    if (line.startsWith('```')) continue;
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    const item = /^[-*] (.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]?.length ?? 1;
      const content = inline(heading[2] ?? '');
      if (level === 1) blocks.push(<h2 key={`h${blocks.length}`} className="text-base">{content}</h2>);
      else blocks.push(<h3 key={`h${blocks.length}`} className="text-sm">{content}</h3>);
    } else if (item) {
      flushParagraph();
      list.push(item[1] ?? '');
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return <div className="space-y-2 text-sm">{blocks}</div>;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text).slice(0, 200);
  if (rows.length === 0) return <p>This file is empty.</p>;
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-xs">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.slice(0, 40).map((cell, cellIndex) => (
                <td key={cellIndex} className="border-b border-line px-2 py-1">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
