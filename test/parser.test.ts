import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { difference, formatAmount, parse, readAmount, validIban } from '../src/parser';
import { render } from '../src/render';

const samples = join(__dirname, '..', '..', 'samples');
const now = new Date('2026-11-07');

test('a Swiss statement: signs, reversal, wrapped text, the IBAN in it, and that it adds up', () => {
  const file = parse(readFileSync(join(samples, 'swiss.mt940'), 'utf8'), now);
  assert.equal(file.statements.length, 2);

  const [jan, feb] = file.statements;
  assert.equal(jan.iban, 'CH5604835012345678009');
  assert.equal(jan.number, '00001/001');
  assert.deepEqual(jan.transactions.map((t) => formatAmount(t.amount)), ['500.00', '-349.50', '-20.00']);
  assert.equal(jan.transactions[0].text, 'GUTSCHRIFT VON Muster AG IBAN CH93 0076 2011 6238 5295 7');
  assert.equal(jan.transactions[0].counterpartyIban, 'CH9300762011623852957');
  assert.equal(jan.transactions[0].customerReference, 'E2E-001');
  assert.equal(jan.transactions[0].bankReference, 'REF-CRED-1');
  assert.equal(jan.transactions[1].bookingDate, '2026-01-11');
  assert.equal(jan.transactions[2].mark, 'RC');
  assert.equal(difference(jan), 0n);

  assert.equal(feb.available.length, 1);
  assert.equal(difference(feb), 0n);
  assert.deepEqual(file.problems, []);
});

test('Raiffeisen: the :NS: block is the text, the address gives the counterparty, a card payment has none', () => {
  const bytes = readFileSync(join(samples, 'raiffeisen.sta'));
  const file = parse(new TextDecoder('windows-1252').decode(bytes), now);
  const s = file.statements[0];

  assert.deepEqual(s.holder.map((d) => `${d.label}: ${d.text}`), ['Holder: Anna Muster', 'Account: Mitglieder Privatkonto', 'Account no.: 00080808']);
  assert.equal(s.transactions.length, 3);
  assert.equal(difference(s), 0n);

  const [transfer, card, salary] = s.transactions;
  assert.ok(transfer.text.startsWith('Übertrag auf Mitglieder Sparkonto'));
  assert.equal(transfer.counterparty, 'Anna Muster');
  assert.equal(transfer.counterpartyIban, 'CH5604835012345678009');
  assert.equal(card.counterparty, undefined);
  assert.ok(card.text.startsWith('Online Einkauf Patreon* Membership'));
  assert.ok(card.text.includes('Wechselkurs 0.8266'));
  assert.equal(salary.counterparty, 'Arbeitgeber AG');
});

test('German ?NN subfields inside a SWIFT envelope: purpose joined across lines, counterparty and IBAN', () => {
  const file = parse(readFileSync(join(samples, 'german.940'), 'utf8'), now);
  assert.deepEqual(file.problems, []);
  const s = file.statements[0];
  assert.equal(s.account, '10020030/1234567890');
  assert.equal(difference(s), 0n);

  const [debit, credit] = s.transactions;
  assert.equal(debit.fundsCode, 'R');
  assert.equal(formatAmount(debit.amount), '-120.45');
  assert.equal(debit.text, 'SEPA-BASISLASTSCHRIFT · EREF+ABC123MREF+M-778SVWZ+Strom Maerz 2026 Kundennr 4711');
  assert.equal(debit.counterparty, 'Stadtwerke Musterstadt');
  assert.equal(debit.counterpartyIban, 'DE89370400440532013000');
  assert.equal(credit.counterparty, 'Arbeitgeber GmbH');
});

test('a file that does not add up says by how much; a broken line is reported, not fatal', () => {
  const file = parse(':20:X\n:25:CH5604835012345678009\n:60F:C260101CHF100,00\n:61:2601050105D10,00NTRFNONREF\n:61:this is not a statement line\n:62F:C260131CHF95,00\n', now);
  const s = file.statements[0];
  assert.equal(s.transactions.length, 1);
  assert.equal(difference(s), -5000n);
  assert.deepEqual(s.problems.map((p) => p.line), [5]);
  assert.ok(render(file, 'x.mt940', 'UTF-8').includes('Off by CHF 5.00'));
});

test('dates: the year around New Year, and an old archive', () => {
  const late = parse(':20:X\n:60F:C260101CHF0,\n:61:2601021230D10,00NTRFNONREF\n:62F:D260102CHF10,\n', now).statements[0];
  assert.equal(late.transactions[0].bookingDate, '2025-12-30');
  const old = parse(':20:X\n:60F:C980101CHF0,\n:61:9801050105C10,00NTRFNONREF\n:62F:C980105CHF10,\n', now).statements[0];
  assert.equal(old.transactions[0].valueDate, '1998-01-05');
});

test('amounts are exact', () => {
  assert.equal(readAmount('0,1') + readAmount('0,2'), readAmount('0,3'));
  assert.equal(formatAmount(readAmount('1234567,5')), '1’234’567.50');
  assert.equal(formatAmount(-readAmount('0,125')), '-0.125');
  assert.ok(validIban('CH9300762011623852957'));
  assert.ok(!validIban('CH9300762011623852958'));
});

test('rendering escapes the bank text', () => {
  const file = parse(':20:X\n:60F:C260101CHF0,\n:61:2601050105C1,00NTRFNONREF\n:86:<script>alert(1)</script>\n:62F:C260105CHF1,\n', now);
  const html = render(file, 'x.mt940', 'UTF-8');
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
});
