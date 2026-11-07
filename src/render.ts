import { Balance, difference, formatAmount, ParsedFile, Statement, Transaction } from './parser';

/**
 * The statement as HTML: per statement its account and balances, whether the entries add up
 * from the opening to the closing balance, and the entries as a table. Pure — the webview's
 * script and security policy are added by the editor.
 */
export function render(file: ParsedFile, fileName: string, encoding: string): string {
  const total = file.statements.reduce((n, s) => n + s.transactions.length, 0);
  const parts: string[] = [];

  parts.push(`<header class="file">
    <h1>${esc(fileName)}</h1>
    <div class="muted">${file.statements.length} statement${file.statements.length === 1 ? '' : 's'} · ${total} entr${total === 1 ? 'y' : 'ies'} · ${esc(encoding)}</div>
    <input id="filter" type="search" placeholder="Filter entries — text, amount, date, reference" autofocus>
  </header>`);

  parts.push(problems(file.problems));
  file.statements.forEach((s, i) => parts.push(statement(s, i, file.statements[i - 1])));

  if (file.statements.length === 0) {
    parts.push('<p class="bad">No statement in this file: there is no :20: tag.</p>');
  }

  return parts.join('\n');
}

function statement(s: Statement, index: number, previous: Statement | undefined): string {
  const currency = s.currency ?? '';
  const diff = difference(s);
  const credits = s.transactions.filter((t) => t.amount > 0n).reduce((a, t) => a + t.amount, 0n);
  const debits = s.transactions.filter((t) => t.amount < 0n).reduce((a, t) => a + t.amount, 0n);

  const check =
    diff === null
      ? '<span class="muted">No opening or closing balance to check against.</span>'
      : diff === 0n
        ? '<span class="good">✓ The entries add up from the opening to the closing balance.</span>'
        : `<span class="bad">✗ Off by ${currency} ${formatAmount(-diff)}: opening + entries = ${formatAmount(s.opening!.amount + credits + debits)}, closing = ${formatAmount(s.closing!.amount)}.</span>`;

  // The same account's previous statement should close where this one opens.
  let gap = '';
  if (previous?.closing && s.opening && (previous.iban ?? previous.account) === (s.iban ?? s.account)
      && previous.closing.amount !== s.opening.amount) {
    gap = `<div class="bad">The previous statement of this account closed at ${formatAmount(previous.closing.amount)}; this one opens at ${formatAmount(s.opening.amount)}.</div>`;
  }

  const holder = s.holder.length > 0
    ? `<div class="muted">${s.holder.map((d) => `${esc(d.label)}: ${esc(d.text)}`).join(' · ')}</div>`
    : '';

  return `<section class="statement">
    <h2>${esc(s.iban ? groupIban(s.iban) : s.account ?? 'No account')}${s.number ? ` <span class="muted">· statement ${esc(s.number)}</span>` : ''}</h2>
    ${holder}
    <div class="muted">${s.reference ? `Reference ${esc(s.reference)} · ` : ''}line ${s.firstLine}${s.opening && s.closing ? ` · ${s.opening.date} to ${s.closing.date}` : ''}</div>
    <div class="balances">
      ${balanceTile('Opening', s.opening)}
      ${tile('In', currency, credits, 'good')}
      ${tile('Out', currency, debits, 'bad')}
      ${balanceTile('Closing', s.closing)}
      ${s.available.map((b) => balanceTile(b.kind === '64' ? 'Available' : 'Forward available', b)).join('')}
    </div>
    <div class="check">${check}</div>
    ${gap}
    ${problems(s.problems)}
    ${s.information ? `<div class="info"><b>Statement information</b> ${esc(s.information)}</div>` : ''}
    ${entries(s.transactions, currency, index)}
  </section>`;
}

function entries(transactions: Transaction[], currency: string, statement: number): string {
  if (transactions.length === 0) {
    return '<p class="muted">No entries.</p>';
  }

  const rows = transactions.map((t, i) => {
    const id = `s${statement}t${i}`;
    const refs = [t.customerReference, t.bankReference && `bank ${t.bankReference}`, t.supplementary]
      .filter(Boolean).map((r) => esc(r!)).join(' · ');
    const details = t.details.length > 0
      ? `<table class="details">${t.details.map((d) => `<tr><td class="code">${esc(d.code)}</td><td class="muted">${esc(d.label)}</td><td>${esc(d.text)}</td></tr>`).join('')}</table>`
      : '';
    const search = [t.bookingDate, t.valueDate, formatAmount(t.amount), t.text, t.counterparty, t.counterpartyIban, refs, t.typeCode]
      .filter(Boolean).join(' ').toLowerCase();

    return `<tbody class="entry" data-search="${esc(search)}">
      <tr class="main" data-target="${id}">
        <td class="date">${t.bookingDate}${t.valueDate !== t.bookingDate ? `<div class="muted">value ${t.valueDate}</div>` : ''}</td>
        <td class="text">
          ${t.counterparty ? `<b>${esc(t.counterparty)}</b><br>` : ''}${esc(t.text) || '<span class="muted">(no text)</span>'}
          ${t.counterpartyIban ? `<div class="muted">${esc(groupIban(t.counterpartyIban))}</div>` : ''}
        </td>
        <td class="type"><span class="chip">${esc(t.typeCode)}</span>${t.mark.startsWith('R') ? ' <span class="chip warn" title="Reversal">reversal</span>' : ''}</td>
        <td class="amount ${t.amount < 0n ? 'bad' : 'good'}">${formatAmount(t.amount)}</td>
        <td class="actions"><a href="#" class="goto" data-line="${t.line}" title="Show in the file">line ${t.line}</a></td>
      </tr>
      <tr class="more" id="${id}" hidden>
        <td></td>
        <td colspan="4">
          ${refs ? `<div class="muted">${refs}</div>` : ''}
          ${details}
          <pre>${esc(t.raw.join('\n'))}</pre>
        </td>
      </tr>
    </tbody>`;
  });

  return `<table class="entries">
    <thead><tr><th>Booked</th><th>Text</th><th>Type</th><th class="amount">${esc(currency)}</th><th></th></tr></thead>
    ${rows.join('\n')}
  </table>`;
}

function balanceTile(label: string, b: Balance | undefined): string {
  if (!b) {
    return `<div class="tile"><div class="muted">${label}</div><div>—</div></div>`;
  }
  return `<div class="tile"><div class="muted">${label} · ${b.date}</div><div class="figure">${esc(b.currency)} ${formatAmount(b.amount)}</div></div>`;
}

function tile(label: string, currency: string, amount: bigint, tone: string): string {
  return `<div class="tile"><div class="muted">${label}</div><div class="figure ${tone}">${esc(currency)} ${formatAmount(amount)}</div></div>`;
}

function problems(list: { line: number; message: string }[]): string {
  if (list.length === 0) {
    return '';
  }
  return `<ul class="problems">${list.map((p) => `<li><a href="#" class="goto" data-line="${p.line}">line ${p.line}</a>: ${esc(p.message)}</li>`).join('')}</ul>`;
}

function groupIban(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, '$1 ');
}

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const styles = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 16px 32px; }
  h1 { font-size: 1.3em; margin: 12px 0 2px; }
  h2 { font-size: 1.15em; margin: 0 0 2px; font-family: var(--vscode-editor-font-family); }
  .muted { color: var(--vscode-descriptionForeground); }
  .good { color: var(--vscode-charts-green); }
  .bad { color: var(--vscode-errorForeground); }
  header.file { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 4px 0 10px; z-index: 1; }
  #filter { margin-top: 8px; width: min(40rem, 100%); padding: 4px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  section.statement { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); }
  .balances { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 6px; }
  .tile { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; min-width: 9rem; }
  .figure { font-family: var(--vscode-editor-font-family); font-size: 1.1em; font-weight: 600; }
  .check { margin: 4px 0 10px; }
  .info { margin: 6px 0; }
  .problems { color: var(--vscode-errorForeground); padding-left: 18px; }
  table.entries { border-collapse: collapse; width: 100%; }
  table.entries th { text-align: left; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; }
  table.entries td { padding: 5px 6px; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border); }
  tr.main { cursor: pointer; }
  tr.main:hover { background: var(--vscode-list-hoverBackground); }
  td.date { white-space: nowrap; font-family: var(--vscode-editor-font-family); }
  td.amount, th.amount { text-align: right; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
  td.actions { white-space: nowrap; text-align: right; }
  .chip { font-size: 0.85em; padding: 0 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.warn { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
  table.details { border-collapse: collapse; margin: 4px 0; }
  table.details td { border: none; padding: 1px 8px 1px 0; }
  td.code { font-family: var(--vscode-editor-font-family); }
  pre { margin: 6px 0 0; padding: 6px; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); white-space: pre-wrap; }
  a { color: var(--vscode-textLink-foreground); }
`;
