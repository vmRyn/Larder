import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';

function theme() {
  const light = document.documentElement.dataset.theme === 'light';
  return light
    ? {
        background: '#f3f3f3',
        foreground: '#1a1a1a',
        cursor: '#005fb8',
        cursorAccent: '#f3f3f3',
        selectionBackground: '#cde6f7',
      }
    : {
        background: '#191919',
        foreground: '#ffffff',
        cursor: '#60cdff',
        cursorAccent: '#191919',
        selectionBackground: '#333333',
      };
}

export function TerminalPane() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/terminal`);
    const sendResize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : '';
      if (data) term.write(data);
    });
    socket.addEventListener('open', () => {
      sendResize();
      term.focus();
    });
    socket.addEventListener('close', () => {
      term.write('\r\n\x1b[90mThe terminal closed.\x1b[0m\r\n');
    });
    const observer = new MutationObserver(() => term.options.theme = theme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const frame = requestAnimationFrame(sendResize);
    window.addEventListener('resize', sendResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', sendResize);
      observer.disconnect();
      input.dispose();
      socket.close();
      term.dispose();
    };
  }, []);

  return <div ref={host} className="terminal-host" />;
}
