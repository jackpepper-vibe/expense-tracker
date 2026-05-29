import type { TripSetup, Receipt, ExpenseCategory } from './data.ts';

// Expenses sheet column per category
const CAT_COL: Record<ExpenseCategory, string> = {
  'Air Fares':              'E',
  'Hotel/Lodging':          'F',
  'Working Meals':          'G',
  'Taxis/Transport':        'H',
  'Client Entertainment':   'I',
  'Marketing/Client Travel':'J',
  'PM Travel/Sales':        'K',
  'Other':                  'L',
};

// Summary sheet column that each Expenses column maps to
const EXP_TO_SUM: Record<string, string> = {
  E:'C', F:'D', G:'E', H:'F', I:'G', J:'H', K:'I', L:'J', M:'K',
};

const EXPENSES_SHEET_PATHS = [
  'xl/worksheets/sheet2.xml',  // Expenses page 1
  'xl/worksheets/sheet3.xml',
  'xl/worksheets/sheet4.xml',
  'xl/worksheets/sheet5.xml',
  'xl/worksheets/sheet6.xml',
  'xl/worksheets/sheet7.xml',  // Expenses page 6
];

const DATA_ROW_FIRST = 9;
const DATA_ROW_LAST  = 21;   // 13 data rows per sheet
const ROWS_PER_SHEET = DATA_ROW_LAST - DATA_ROW_FIRST + 1;
const AMT_COLS       = ['E','F','G','H','I','J','K','L'] as const;

type ColTotals = Record<string, number>;

// ── Pure helpers ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function isoToExcelSerial(iso: string): number {
  return Math.floor(new Date(iso + 'T12:00:00Z').getTime() / 86_400_000) + 25_569;
}

function fmt(n: number): string {
  return n === 0 ? '0' : n.toFixed(2);
}

// ── XML cell builders ─────────────────────────────────────────────────────────

function inlineStrCell(ref: string, style: string, value: string): string {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function numCell(ref: string, style: string, value: number): string {
  return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
}

function emptyCell(ref: string, style: string): string {
  return `<c r="${ref}" s="${style}"/>`;
}

// Replace the entire cell element (handles self-closing and content forms)
function replaceCell(xml: string, ref: string, replacement: string): string {
  const selfClose  = new RegExp(`<c r="${ref}"[^>]*/>`);
  const withContent = new RegExp(`<c r="${ref}"[\\s\\S]*?</c>`);
  if (selfClose.test(xml))    return xml.replace(selfClose, replacement);
  if (withContent.test(xml))  return xml.replace(withContent, replacement);
  return xml;
}

// Update only the cached <v> value inside an existing formula cell — leaves
// the formula itself, style, and all other attributes untouched.
function updateCachedValue(xml: string, ref: string, value: number): string {
  const marker = `<c r="${ref}"`;
  const start = xml.indexOf(marker);
  if (start === -1) return xml;
  const end     = xml.indexOf('</c>', start) + 4;
  const cellXml = xml.slice(start, end);
  const updated = cellXml.replace(/<v>[^<]*<\/v>/, `<v>${fmt(value)}</v>`);
  return xml.slice(0, start) + updated + xml.slice(end);
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildDataRow(rowNum: number, receipt: Receipt | null, globalSeq: number): string {
  const r       = rowNum;
  const eStyle  = r >= 17 ? '188' : '125';
  const flStyle = r >= 17 ? '189' : '126';

  if (!receipt) {
    return [
      `<row r="${r}" s="1" customFormat="1" ht="30" customHeight="1">`,
      numCell(`A${r}`, '121', globalSeq),
      emptyCell(`B${r}`, '122'),
      emptyCell(`C${r}`, '185'),
      emptyCell(`D${r}`, '186'),
      ...AMT_COLS.map(c => emptyCell(`${c}${r}`, c === 'E' ? eStyle : flStyle)),
      `<c r="M${r}" s="101"><f>SUM(E${r}:L${r})</f><v>0</v></c>`,
      `</row>`,
    ].join('');
  }

  const amtCol    = CAT_COL[receipt.category];
  const amtCells  = AMT_COLS.map(c => {
    const s = c === 'E' ? eStyle : flStyle;
    return c === amtCol ? numCell(`${c}${r}`, s, receipt.amount) : emptyCell(`${c}${r}`, s);
  }).join('');

  return [
    `<row r="${r}" s="1" customFormat="1" ht="30" customHeight="1">`,
    numCell(`A${r}`, '121', receipt.no),
    numCell(`B${r}`, '122', isoToExcelSerial(receipt.date)),
    inlineStrCell(`C${r}`, '185', receipt.location),
    inlineStrCell(`D${r}`, '186', receipt.nature),
    amtCells,
    `<c r="M${r}" s="101"><f>SUM(E${r}:L${r})</f><v>${receipt.amount.toFixed(2)}</v></c>`,
    `</row>`,
  ].join('');
}

function replaceRow(xml: string, rowNum: number, newRow: string): string {
  return xml.replace(new RegExp(`<row r="${rowNum}"[\\s\\S]*?</row>`), newRow);
}

// ── Totals computation ────────────────────────────────────────────────────────

function pageReceipts(receipts: Receipt[], pageIdx: number): Receipt[] {
  return receipts.slice(pageIdx * ROWS_PER_SHEET, (pageIdx + 1) * ROWS_PER_SHEET);
}

function computeTotals(rs: Receipt[]): ColTotals {
  const t: ColTotals = { E:0, F:0, G:0, H:0, I:0, J:0, K:0, L:0, M:0 };
  for (const r of rs) {
    const c = CAT_COL[r.category];
    t[c] += r.amount;
    t['M'] += r.amount;
  }
  return t;
}

function sumTotals(pages: ColTotals[]): ColTotals {
  const t: ColTotals = { E:0, F:0, G:0, H:0, I:0, J:0, K:0, L:0, M:0 };
  for (const p of pages) for (const k of Object.keys(t)) t[k] += p[k] ?? 0;
  return t;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateExpenseFormXlsx(
  setup: TripSetup,
  receipts: Receipt[],
): Promise<string> {
  const { default: JSZip } = await import('jszip');

  const response = await fetch('/expense_form.xlsx');
  if (!response.ok) throw new Error('Could not load expense form template');
  const zip = await JSZip.loadAsync(await response.arrayBuffer());

  // Remove stale calc chain
  zip.remove('xl/calcChain.xml');

  // Force full recalculation on open (belt-and-suspenders)
  const wbFile = zip.file('xl/workbook.xml');
  if (wbFile) {
    const wbXml = (await wbFile.async('string'))
      .replace(/<calcPr([^/]*)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
    zip.file('xl/workbook.xml', wbXml);
  }

  // ── Process each Expenses sheet ───────────────────────────────────────────

  const pageTotals: ColTotals[] = [];

  for (let si = 0; si < EXPENSES_SHEET_PATHS.length; si++) {
    const file = zip.file(EXPENSES_SHEET_PATHS[si]);
    if (!file) { pageTotals.push({ E:0,F:0,G:0,H:0,I:0,J:0,K:0,L:0,M:0 }); continue; }

    let xml = await file.async('string');

    // Employee name in C6
    xml = replaceCell(xml, 'C6', inlineStrCell('C6', '192', setup.name));

    // Data rows 9–21
    const page = pageReceipts(receipts, si);
    for (let ri = 0; ri < ROWS_PER_SHEET; ri++) {
      const rowNum = DATA_ROW_FIRST + ri;
      xml = replaceRow(xml, rowNum, buildDataRow(rowNum, page[ri] ?? null, si * ROWS_PER_SHEET + ri + 1));
    }

    // Compute totals for this page and write cached values into rows 24 & 25
    const pt = computeTotals(page);
    pageTotals.push(pt);

    for (const col of [...AMT_COLS, 'M']) {
      xml = updateCachedValue(xml, `${col}24`, pt[col] ?? 0);
      xml = updateCachedValue(xml, `${col}25`, pt[col] ?? 0);
    }

    zip.file(EXPENSES_SHEET_PATHS[si], xml);
  }

  // ── Process Summary sheet ─────────────────────────────────────────────────

  const grand = sumTotals(pageTotals);

  const summaryFile = zip.file('xl/worksheets/sheet1.xml');
  if (summaryFile) {
    let xml = await summaryFile.async('string');

    // Header fields
    xml = replaceCell(xml, 'B12', inlineStrCell('B12', '192', setup.name));
    xml = replaceCell(xml, 'H10', inlineStrCell('H10', '203', setup.businessPurpose));

    if (receipts.length > 0) {
      const dates = receipts.map(r => r.date).sort();
      xml = replaceCell(xml, 'C9',  numCell('C9',  '207', isoToExcelSerial(dates[0])));
      xml = replaceCell(xml, 'C10', numCell('C10', '207', isoToExcelSerial(dates[dates.length - 1])));
    }

    // Per-page totals: Summary rows 17–22 (one per Expenses sheet)
    for (let si = 0; si < EXPENSES_SHEET_PATHS.length; si++) {
      const summaryRow = 17 + si;
      const pt = pageTotals[si];
      for (const [expCol, sumCol] of Object.entries(EXP_TO_SUM)) {
        xml = updateCachedValue(xml, `${sumCol}${summaryRow}`, pt[expCol] ?? 0);
      }
    }

    // Grand total row 23
    for (const [expCol, sumCol] of Object.entries(EXP_TO_SUM)) {
      xml = updateCachedValue(xml, `${sumCol}23`, grand[expCol] ?? 0);
    }

    // K28 = total expenses claimed (grand total, assuming no advances)
    xml = updateCachedValue(xml, 'K28', grand['M'] ?? 0);

    zip.file('xl/worksheets/sheet1.xml', xml);
  }

  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
