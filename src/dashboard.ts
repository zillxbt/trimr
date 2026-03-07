import blessed from 'blessed';
import { getAllSessions } from './session.js';
import { calculateCost } from './pricing.js';

// ── Logging ───────────────────────────────────────────────────────────────────
// log() is called from proxy.ts; before the dashboard starts it just uses
// console.log, then gets replaced with a blessed-aware version.

let _logFn: (msg: string) => void = (msg) => console.log(msg);

export function log(msg: string): void {
  _logFn(msg);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function startDashboard(port: number): void {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'TokenDiff',
    fullUnicode: true,
  });

  // ── Header ──────────────────────────────────────────────────────────────
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content:
      `{center}{bold}{green-fg}TokenDiff{/green-fg}{/bold}` +
      `  |  proxy on :${port}  |  [q] quit{/center}`,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'green' } },
  });

  // ── Sessions table ───────────────────────────────────────────────────────
  const sessionsBox = blessed.box({
    top: 3,
    left: 0,
    width: '100%',
    height: '65%-3',
    label: ' Sessions ',
    tags: true,
    border: { type: 'line' },
    scrollable: true,
    alwaysScroll: true,
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
    },
  });

  // ── Log panel ────────────────────────────────────────────────────────────
  const logBox = blessed.log({
    bottom: 3,
    left: 0,
    width: '100%',
    height: '35%-3',
    label: ' Events ',
    tags: true,
    border: { type: 'line' },
    scrollable: true,
    alwaysScroll: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scrollbar: { style: { bg: 'green' } } as any,
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
    },
  });

  // ── Footer ───────────────────────────────────────────────────────────────
  const footer = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'green' } },
  });

  screen.append(header);
  screen.append(sessionsBox);
  screen.append(logBox);
  screen.append(footer);

  // Redirect log() to the blessed log panel
  _logFn = (msg: string) => {
    logBox.log(`{grey-fg}${new Date().toTimeString().slice(0, 8)}{/grey-fg}  ${msg}`);
    screen.render();
  };

  screen.key(['q', 'C-c'], () => process.exit(0));

  // ── Render loop ──────────────────────────────────────────────────────────

  // Columns: Session, Reqs, Est.In, Saved, Cache, Diffs, Dedup, $Saved, Ratio
  // Note: session.id is now an API key hash (key:xxxx) or explicit header value
  const COL = [18, 6, 11, 11, 8, 7, 7, 9, 7] as const;
  const pad = (s: string | number, w: number) =>
    String(s).slice(0, w).padEnd(w);

  function renderHeader(): string {
    return (
      '{bold}{cyan-fg}' +
      pad('Session', COL[0]) +
      pad('Reqs', COL[1]) +
      pad('Est.In', COL[2]) +
      pad('Saved', COL[3]) +
      pad('Cache', COL[4]) +
      pad('Diffs', COL[5]) +
      pad('Dedup', COL[6]) +
      pad('$Saved', COL[7]) +
      pad('Ratio', COL[8]) +
      '{/cyan-fg}{/bold}'
    );
  }

  function renderRow(s: ReturnType<typeof getAllSessions>[number]): string {
    const ratio =
      s.stats.tokensOriginal > 0
        ? ((s.stats.tokensSaved / s.stats.tokensOriginal) * 100).toFixed(1) + '%'
        : '0%';
    const dollarSaved = '$' + calculateCost(s.stats.tokensSaved, 'claude-sonnet-4-6', 'input').toFixed(4);
    const idle = Math.round((Date.now() - s.lastActivity) / 1000);
    const idleStr = idle < 60 ? `${idle}s` : `${Math.round(idle / 60)}m`;
    const shortId = s.id.length > 16 ? s.id.slice(0, 15) + '…' : s.id;

    return (
      pad(shortId, COL[0]) +
      pad(s.stats.requestCount, COL[1]) +
      pad(s.stats.tokensOriginal, COL[2]) +
      pad(s.stats.tokensSaved, COL[3]) +
      pad(s.stats.cacheHits, COL[4]) +
      pad(s.stats.diffsSent, COL[5]) +
      pad(s.stats.dedupHits, COL[6]) +
      pad(dollarSaved, COL[7]) +
      pad(ratio, COL[8]) +
      `  {grey-fg}idle ${idleStr}{/grey-fg}`
    );
  }

  function update(): void {
    const sessions = getAllSessions();

    const lines: string[] = [renderHeader(), '─'.repeat(87)];

    let totalIn = 0;
    let totalSaved = 0;
    let totalRealIn = 0;
    let totalOut = 0;
    let totalCacheRead = 0;

    for (const s of sessions) {
      totalIn += s.stats.tokensOriginal;
      totalSaved += s.stats.tokensSaved;
      totalRealIn += s.stats.realInputTokens;
      totalOut += s.stats.outputTokens;
      totalCacheRead += s.stats.cacheReadTokens;
      lines.push(renderRow(s));
    }

    if (sessions.length === 0) {
      lines.push(
        '  {grey-fg}No active sessions yet. Point your client at http://localhost:' +
          port +
          '{/grey-fg}',
      );
    }

    sessionsBox.setContent(lines.join('\n'));

    const overallRatio =
      totalIn > 0 ? ((totalSaved / totalIn) * 100).toFixed(1) + '%' : '0%';
    const totalDollar = '$' +
      calculateCost(totalSaved, 'claude-sonnet-4-6', 'input').toFixed(4);

    const realInStr = totalRealIn > 0 ? `  actual: ${totalRealIn}` : '';
    const outStr = totalOut > 0 ? `  out: ${totalOut}` : '';
    const cacheReadStr = totalCacheRead > 0 ? `  cache-read: ${totalCacheRead}` : '';

    footer.setContent(
      ` {bold}Total:{/bold}  ${totalIn} est.in${realInStr}${outStr}${cacheReadStr}  |  ` +
        `${totalSaved} saved  |  ${totalDollar}  |  compression ${overallRatio}  |  sessions: ${sessions.length}`,
    );

    screen.render();
  }

  update();
  setInterval(update, 1_000);

  log(`TokenDiff proxy started on http://localhost:${port}`);
}
