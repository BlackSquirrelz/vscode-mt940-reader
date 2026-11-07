/**
 * SWIFT MT940, read for display.
 *
 * The rules are HomeERP's (Mt940Parser.cs), so a file looks here the way it imports there:
 * one statement per :20:, Raiffeisen's :NS: blocks as the entry text, the entry date's year
 * taken from the value date, RC/RD flipping the sign. Unlike the importer this never gives up
 * on a file: a line it cannot read is kept, shown, and reported with its line number.
 *
 * Amounts are kept as integers of thousandths (bigint), never as floating point: a balance
 * check that is off by 0.0000001 is a check that lies.
 */

export interface Problem {
  line: number; // 1-based, in the file
  message: string;
}

export interface Balance {
  kind: string; // 60F, 60M, 62F, 62M, 64, 65
  date: string; // ISO yyyy-mm-dd
  currency: string;
  amount: bigint; // thousandths, signed
  line: number;
}

export interface Detail {
  code: string; // "17", "?20", ...
  label: string;
  text: string;
}

export interface Transaction {
  line: number;
  valueDate: string;
  bookingDate: string;
  mark: string; // C, D, RC, RD, EC, ED
  fundsCode?: string;
  amount: bigint; // thousandths, signed: credit positive
  typeCode: string; // NTRF, FMSC, ...
  customerReference?: string;
  bankReference?: string;
  supplementary?: string;
  text: string; // the entry text, one string
  details: Detail[]; // the text's subfields, when it has any
  counterparty?: string;
  counterpartyIban?: string;
  raw: string[]; // the file's lines for this entry
}

export interface Field {
  tag: string;
  value: string;
  line: number;
}

export interface Statement {
  reference?: string; // :20:
  related?: string; // :21:
  account?: string; // :25:
  iban?: string;
  number?: string; // :28: / :28C:
  holder: Detail[]; // a header :NS: block (Raiffeisen: 22 holder, 23 account name)
  opening?: Balance;
  closing?: Balance;
  available: Balance[]; // :64:, :65:
  transactions: Transaction[];
  currency?: string;
  information?: string; // an :86: after the last transaction, before or after :62:
  firstLine: number;
  problems: Problem[];
}

export interface ParsedFile {
  statements: Statement[];
  problems: Problem[]; // ones outside any statement
}

const TagStart = /^:(\d{2}[A-Z]?|NS):/;
const TransactionLine =
  /^(\d{6})(\d{4})?(RC|RD|EC|ED|C|D)([A-Z])?([\d,]{1,15})([A-Z][A-Z0-9]{3})([^/\r\n]{0,16})(?:\/\/([^\r\n]{0,16}))?(.*)$/;
const BalanceLine = /^([CD])(\d{6})([A-Z]{3})([\d,]+)$/;
const PostcodeTown = /^\d{4,5}\s+\S/;
const IbanLike = /\b[A-Z]{2}\d{2} ?(?:[A-Z0-9]{4} ?){2,7}[A-Z0-9]{1,4}\b/g;

/** Splits the file into tags, joining wrapped lines; SWIFT {1:..}{2:..}{4: wrappers and '-' are dropped. */
export function readFields(content: string): { fields: Field[]; problems: Problem[] } {
  const fields: Field[] = [];
  const problems: Problem[] = [];
  let current: { tag: string; parts: string[]; line: number } | undefined;

  const flush = () => {
    if (current) {
      fields.push({ tag: current.tag, value: join(current.tag, current.parts), line: current.line });
    }
    current = undefined;
  };

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\r$/, '');

    // A SWIFT envelope: "{1:F01...}{2:O940...}{4:" before the first tag, "-}" at the end.
    line = line.replace(/^(\{\d:[^{}]*\})*\{4:/, '');
    if (/^-?\}?(\{5:.*)?$/.test(line.trim()) || line.trim() === '-') {
      if (line.trim().length > 0) {
        flush();
      }
      continue;
    }

    const match = TagStart.exec(line);
    if (match) {
      flush();
      current = { tag: match[1], parts: [line.slice(match[0].length)], line: i + 1 };
    } else if (current) {
      current.parts.push(line);
    } else if (line.trim().length > 0) {
      problems.push({ line: i + 1, message: `Text before the first tag: "${line.trim().slice(0, 60)}"` });
    }
  }

  flush();
  return { fields, problems };
}

/**
 * :NS: keeps its line breaks (one numbered subfield per line); German :86: with ?NN subfields
 * wraps at a fixed width mid-word, so it is joined with nothing; anything else with a space.
 */
function join(tag: string, parts: string[]): string {
  if (tag === 'NS') {
    return parts.map((p) => p.trim()).join('\n').trim();
  }

  if (tag === '86' && /^\d{3}\?/.test(parts[0].trim())) {
    return parts.map((p) => p.replace(/\s+$/, '')).join('').trim();
  }

  return parts.map((p) => p.trim()).filter((p) => p.length > 0).join(' ').trim();
}

export function parse(content: string, now: Date = new Date()): ParsedFile {
  const { fields, problems } = readFields(content);
  const blocks: Field[][] = [];
  for (const field of fields) {
    if (field.tag === '20' || blocks.length === 0) {
      blocks.push([]);
    }
    blocks[blocks.length - 1].push(field);
  }

  const lines = content.split('\n');
  const statements = blocks.map((block) => readStatement(block, lines, now));
  return { statements, problems };
}

function readStatement(fields: Field[], fileLines: string[], now: Date): Statement {
  const s: Statement = {
    holder: [],
    available: [],
    transactions: [],
    firstLine: fields[0]?.line ?? 1,
    problems: [],
  };

  let pending: Transaction | undefined;
  const flush = () => {
    if (pending) {
      finish(pending);
      s.transactions.push(pending);
    }
    pending = undefined;
  };

  for (const field of fields) {
    try {
      switch (field.tag) {
        case '20':
          s.reference ??= field.value;
          break;
        case '21':
          s.related ??= field.value;
          break;
        case '25':
          s.account ??= field.value;
          s.iban ??= ibanIn(field.value.split('/').pop() ?? '');
          break;
        case '28':
        case '28C':
          s.number ??= field.value;
          break;
        case '60F':
        case '60M': {
          flush();
          const b = readBalance(field, now);
          s.opening ??= b;
          s.currency ??= b.currency;
          break;
        }
        case '62F':
        case '62M': {
          flush();
          const b = readBalance(field, now);
          s.closing = b;
          s.currency ??= b.currency;
          break;
        }
        case '64':
        case '65':
          flush();
          s.available.push(readBalance(field, now));
          break;
        case '61':
          flush();
          pending = readTransaction(field, now);
          break;
        case 'NS':
          if (pending) {
            const details = numberedDetails(field.value);
            pending.details.push(...details);
            pending.text = append(pending.text, nsText(details));
            pending.counterparty ??= nsCounterparty(details);
          } else {
            s.holder.push(...numberedDetails(field.value).map((d) => ({ ...d, label: headerLabel(d.code) })));
          }
          break;
        case '86':
          if (pending) {
            const details = gvcDetails(field.value);
            if (details.length > 0) {
              pending.details.push(...details);
              pending.text = append(pending.text, gvcText(details));
              pending.counterparty ??= gvcCounterparty(details);
              pending.counterpartyIban ??= ibanIn(details.find((d) => d.code === '?31')?.text ?? '');
            } else {
              pending.text = append(pending.text, field.value);
            }
          } else {
            s.information = append(s.information ?? '', field.value);
          }
          break;
        default:
          break;
      }
    } catch (e) {
      s.problems.push({ line: field.line, message: (e as Error).message });
    }

    // The raw lines of an entry: its :61: and what follows it up to the next tag of the statement.
    if (pending && (field.tag === '61' || field.tag === '86' || field.tag === 'NS')) {
      const next = fields[fields.indexOf(field) + 1]?.line ?? fileLines.length + 1;
      for (let i = field.line - 1; i < next - 1; i++) {
        const text = fileLines[i]?.replace(/\r$/, '') ?? '';
        if (text.trim().length > 0 && text.trim() !== '-') {
          pending.raw.push(text);
        }
      }
    }
  }

  flush();
  if (!s.currency) {
    s.problems.push({ line: s.firstLine, message: 'No :60F: or :62F: balance, so no currency.' });
  }

  return s;
}

function finish(t: Transaction) {
  if (!t.text) {
    t.text = t.customerReference ?? '';
  }
  t.counterpartyIban ??= ibanIn(t.text);
}

function append(a: string, b: string): string {
  if (!b) {
    return a;
  }
  return a ? `${a} · ${b}` : b;
}

function readTransaction(field: Field, now: Date): Transaction {
  const m = TransactionLine.exec(field.value);
  if (!m) {
    throw new Error(`":61:${field.value.slice(0, 40)}" is not a statement line.`);
  }

  const valueDate = readShortDate(m[1], now);
  const bookingDate = m[2] ? readEntryDate(m[2], valueDate) : valueDate;
  const mark = m[3];
  const magnitude = readAmount(m[5]);
  const amount = mark === 'C' || mark === 'EC' || mark === 'RD' ? magnitude : -magnitude;
  const customer = m[7].trim();

  return {
    line: field.line,
    valueDate,
    bookingDate,
    mark,
    fundsCode: m[4],
    amount,
    typeCode: m[6],
    customerReference: customer && customer !== 'NONREF' ? customer : undefined,
    bankReference: m[8]?.trim() || undefined,
    supplementary: m[9]?.trim() || undefined,
    text: '',
    details: [],
    raw: [],
  };
}

function readBalance(field: Field, now: Date): Balance {
  const m = BalanceLine.exec(field.value.trim());
  if (!m) {
    throw new Error(`":${field.tag}:${field.value}" is not a balance.`);
  }
  const amount = readAmount(m[4]);
  return {
    kind: field.tag,
    date: readShortDate(m[2], now),
    currency: m[3],
    amount: m[1] === 'D' ? -amount : amount,
    line: field.line,
  };
}

/** "1234,5" → 1234500 thousandths. */
export function readAmount(text: string): bigint {
  if (!/^\d+(,\d*)?$/.test(text)) {
    throw new Error(`"${text}" is not an amount.`);
  }
  const [whole, fraction = ''] = text.split(',');
  if (fraction.length > 3) {
    throw new Error(`"${text}" has more decimals than any currency.`);
  }
  return BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3));
}

/** YYMMDD; a year more than one ahead of now is the previous century. */
export function readShortDate(text: string, now: Date): string {
  if (!/^\d{6}$/.test(text)) {
    throw new Error(`"${text}" is not a YYMMDD date.`);
  }
  let year = 2000 + Number(text.slice(0, 2));
  if (year > now.getFullYear() + 1) {
    year -= 100;
  }
  return isoDate(year, Number(text.slice(2, 4)), Number(text.slice(4, 6)), text);
}

/** MMDD, the year from the value date — around New Year the entry can sit in the other one. */
export function readEntryDate(text: string, valueDate: string): string {
  const month = Number(text.slice(0, 2));
  const valueMonth = Number(valueDate.slice(5, 7));
  let year = Number(valueDate.slice(0, 4));
  if (month === 12 && valueMonth === 1) {
    year--;
  } else if (month === 1 && valueMonth === 12) {
    year++;
  }
  return isoDate(year, month, Number(text.slice(2, 4)), text);
}

function isoDate(year: number, month: number, day: number, text: string): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`"${text}" is not a real date.`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── :NS: — Raiffeisen and other Swiss banks ─────────────────────────────────

function numberedDetails(value: string): Detail[] {
  const byCode = new Map<string, string>();
  for (const raw of value.split('\n')) {
    const line = raw.trim();
    const m = /^(\d{2})(.*)$/.exec(line);
    if (m && m[2].trim().length > 0) {
      byCode.set(m[1], byCode.has(m[1]) ? `${byCode.get(m[1])} ${m[2].trim()}` : m[2].trim());
    }
  }
  return [...byCode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, text]) => ({ code, label: nsLabel(code), text }));
}

function hasAddress(details: Detail[]): boolean {
  const town = details.find((d) => d.code === '03')?.text;
  const country = details.find((d) => d.code === '04')?.text;
  return (town !== undefined && PostcodeTown.test(town)) || (country !== undefined && /^[A-Z]{2}$/.test(country));
}

/** 01–04 are a name and address only when they look like one; on a card payment they are more text. */
function nsCounterparty(details: Detail[]): string | undefined {
  return hasAddress(details) ? details.find((d) => d.code === '01')?.text : undefined;
}

function nsText(details: Detail[]): string {
  const address = hasAddress(details);
  const parts: string[] = [];
  const booking = details.find((d) => d.code === '17');
  if (booking) {
    parts.push(booking.text);
  }
  for (const d of details) {
    const n = Number(d.code);
    if (n === 1 || (n >= 5 && n <= 16) || (n >= 2 && n <= 4 && !address)) {
      if (!parts.includes(d.text)) {
        parts.push(d.text);
      }
    }
  }
  return parts.join(' · ');
}

function nsLabel(code: string): string {
  const n = Number(code);
  if (n === 1) return 'Name / text';
  if (n >= 2 && n <= 4) return 'Address / text';
  if (n === 17) return 'Booking text';
  return 'Text';
}

function headerLabel(code: string): string {
  switch (code) {
    case '22':
      return 'Holder';
    case '23':
      return 'Account';
    case '30':
      return 'Account no.';
    default:
      return 'Header';
  }
}

// ── :86: with ?NN subfields — the German structured format ──────────────────

function gvcDetails(value: string): Detail[] {
  const m = /^(\d{3})(\?.*)$/s.exec(value);
  if (!m) {
    return [];
  }
  const details: Detail[] = [{ code: 'GVC', label: 'Transaction code', text: m[1] }];
  for (const part of m[2].split('?').slice(1)) {
    const code = part.slice(0, 2);
    const text = part.slice(2).trim();
    if (/^\d{2}$/.test(code) && text.length > 0) {
      details.push({ code: `?${code}`, label: gvcLabel(Number(code)), text });
    }
  }
  return details;
}

function gvcLabel(n: number): string {
  if (n === 0) return 'Booking text';
  if (n === 10) return 'Primanota';
  if ((n >= 20 && n <= 29) || (n >= 60 && n <= 63)) return 'Purpose';
  if (n === 30) return 'Bank code / BIC';
  if (n === 31) return 'Account / IBAN';
  if (n === 32 || n === 33) return 'Counterparty';
  if (n === 34) return 'Text key addition';
  return 'Subfield';
}

function gvcText(details: Detail[]): string {
  const booking = details.find((d) => d.code === '?00')?.text;
  const purpose = details
    .filter((d) => d.label === 'Purpose')
    .map((d) => d.text)
    .join('');
  return [booking, purpose].filter((p) => p && p.length > 0).join(' · ');
}

function gvcCounterparty(details: Detail[]): string | undefined {
  const name = details
    .filter((d) => d.code === '?32' || d.code === '?33')
    .map((d) => d.text)
    .join('');
  return name.length > 0 ? name : undefined;
}

// ── IBAN ────────────────────────────────────────────────────────────────────

export function ibanIn(text: string): string | undefined {
  for (const m of text.toUpperCase().matchAll(IbanLike)) {
    const candidate = m[0].replace(/ /g, '');
    if (validIban(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function validIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) {
    return false;
  }
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) {
      rest = (rest * 10 + Number(d)) % 97;
    }
  }
  return rest === 1;
}

// ── Checks and formatting ───────────────────────────────────────────────────

/** Opening plus the entries, against the closing balance: null when either balance is missing. */
export function difference(s: Statement): bigint | null {
  if (!s.opening || !s.closing) {
    return null;
  }
  const sum = s.transactions.reduce((acc, t) => acc + t.amount, 0n);
  return s.opening.amount + sum - s.closing.amount;
}

/** 1234500 thousandths → "1'234.50"; three decimals only when the third is not zero. */
export function formatAmount(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '’');
  const fraction = (abs % 1000n).toString().padStart(3, '0');
  const decimals = fraction.endsWith('0') ? fraction.slice(0, 2) : fraction;
  return `${negative ? '-' : ''}${whole}.${decimals}`;
}
