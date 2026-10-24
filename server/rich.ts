function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

export function csvTable(text: string): string {
  const rows = parseCsv(text).slice(0, 200);
  if (rows.length === 0) return '<p class="empty">This file is empty.</p>';
  const body = rows
    .map((row) => `<tr>${row.slice(0, 40).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  const more = parseCsv(text).length > 200 ? '<p class="more">Showing the first 200 rows.</p>' : '';
  return `<div class="table-wrap"><table>${body}</table></div>${more}`;
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

function inlineMarkdown(source: string): string {
  let html = '';
  let rest = source;
  while (rest.length > 0) {
    const code = rest.match(/^`([^`]+)`/);
    const bold = rest.match(/^\*\*([^*]+)\*\*/);
    const italic = rest.match(/^\*([^*]+)\*/);
    const link = rest.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
    const match = code ?? bold ?? italic ?? link;
    if (!match) {
      html += escapeHtml(rest[0] ?? '');
      rest = rest.slice(1);
      continue;
    }
    if (match === code) html += `<code>${escapeHtml(match[1] ?? '')}</code>`;
    else if (match === bold) html += `<strong>${escapeHtml(match[1] ?? '')}</strong>`;
    else if (match === italic) html += `<em>${escapeHtml(match[1] ?? '')}</em>`;
    else html += `<a href="${escapeHtml(match[2] ?? '')}" rel="noopener noreferrer">${escapeHtml(match[1] ?? '')}</a>`;
    rest = rest.slice(match[0].length);
  }
  return html;
}

export function markdownHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of lines) {
    const fence = line.startsWith('```');
    if (fence) continue;
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    const item = /^[-*] (.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${inlineMarkdown(heading[2] ?? '')}</h${level}>`);
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
  return `<div class="markdown">${out.join('')}</div>`;
}
