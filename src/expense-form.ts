import type { TripSetup, Receipt, ExpenseCategory } from './data.ts';

// Column mapping: ExpenseCategory → spreadsheet column letter
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

// sheet2.xml = Expenses page 1, sheet3 = page 2, …, sheet7 = page 6
const EXPENSES_SHEET_PATHS = [
  'xl/worksheets/sheet2.xml',
  'xl/worksheets/sheet3.xml',
  'xl/worksheets/sheet4.xml',
  'xl/worksheets/sheet5.xml',
  'xl/worksheets/sheet6.xml',
  'xl/worksheets/sheet7.xml',
];

const DATA_ROW_FIRST = 9;
const DATA_ROW_LAST  = 21; // 13 data rows per Expenses sheet
const ROWS_PER_SHEET = DATA_ROW_LAST - DATA_ROW_FIRST + 1;

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function isoToExcelSerial(iso: string): number {
  // Days since Jan 0 1900 (Excel epoch), accounting for the 1900 leap-year bug
  const d = new Date(iso + 'T12:00:00Z');
  return Math.floor(d.getTime() / 86_400_000) + 25_569;
}

// Replace a complete cell element (handles content or self-closing form)
function replaceCell(xml: string, ref: string, replacement: string): string {
  // Match self-closing form first, then form with content
  const selfClose = new RegExp(`<c r="${ref}"[^>]*/>`);
  const withContent = new RegExp(`<c r="${ref}"[\\s\\S]*?</c>`);
  if (selfClose.test(xml))   return xml.replace(selfClose, replacement);
  if (withContent.test(xml)) return xml.replace(withContent, replacement);
  return xml;
}

function inlineStrCell(ref: string, style: string, value: string): string {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function numCell(ref: string, style: string, value: number): string {
  return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
}

function emptyCell(ref: string, style: string): string {
  return `<c r="${ref}" s="${style}"/>`;
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildDataRow(rowNum: number, receipt: Receipt | null, globalSeq: number): string {
  const r = rowNum;
  // First row in the group defines the shared-formula range; others just reference it.
  // To avoid si-index conflicts between sheets, use explicit formulas throughout.
  const mFormula = `<f>SUM(E${r}:L${r})</f>`;

  // Rows 17-21 use slightly different border styles (bottom of page area)
  const eStyle  = r >= 17 ? '188' : '125';
  const flStyle = r >= 17 ? '189' : '126';

  if (!receipt) {
    return [
      `<row r="${r}" s="1" customFormat="1" ht="30" customHeight="1">`,
      numCell(`A${r}`, '121', globalSeq),
      emptyCell(`B${r}`, '122'),
      emptyCell(`C${r}`, '185'),
      emptyCell(`D${r}`, '186'),
      emptyCell(`E${r}`, eStyle),
      emptyCell(`F${r}`, flStyle),
      emptyCell(`G${r}`, flStyle),
      emptyCell(`H${r}`, flStyle),
      emptyCell(`I${r}`, flStyle),
      emptyCell(`J${r}`, flStyle),
      emptyCell(`K${r}`, flStyle),
      emptyCell(`L${r}`, flStyle),
      `<c r="M${r}" s="101">${mFormula}<v>0</v></c>`,
      `</row>`,
    ].join('');
  }

  const amtCol = CAT_COL[receipt.category];
  const amount = receipt.amount;
  const amountStr = amount.toFixed(2);
  const AMT_COLS = ['E','F','G','H','I','J','K','L'] as const;

  const amtCells = AMT_COLS.map(col => {
    const s = col === 'E' ? eStyle : flStyle;
    return col === amtCol
      ? numCell(`${col}${r}`, s, amount)
      : emptyCell(`${col}${r}`, s);
  }).join('');

  return [
    `<row r="${r}" s="1" customFormat="1" ht="30" customHeight="1">`,
    numCell(`A${r}`, '121', receipt.no),
    numCell(`B${r}`, '122', isoToExcelSerial(receipt.date)),
    inlineStrCell(`C${r}`, '185', receipt.location),
    inlineStrCell(`D${r}`, '186', receipt.nature),
    amtCells,
    `<c r="M${r}" s="101">${mFormula}<v>${amountStr}</v></c>`,
    `</row>`,
  ].join('');
}

function replaceRow(xml: string, rowNum: number, newRow: string): string {
  const regex = new RegExp(`<row r="${rowNum}"[\\s\\S]*?</row>`);
  return xml.replace(regex, newRow);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateExpenseFormXlsx(
  setup: TripSetup,
  receipts: Receipt[],
): Promise<string> {
  const { default: JSZip } = await import('jszip');

  const response = await fetch('/expense_form.xlsx');
  if (!response.ok) throw new Error('Could not load expense form template');
  const buffer = await response.arrayBuffer();

  const zip = await JSZip.loadAsync(buffer);

  // Remove stale calc chain → Excel will recalculate on open
  zip.remove('xl/calcChain.xml');

  // ── Fill each Expenses sheet ──────────────────────────────────────────────

  for (let si = 0; si < EXPENSES_SHEET_PATHS.length; si++) {
    const path = EXPENSES_SHEET_PATHS[si];
    const file = zip.file(path);
    if (!file) continue;

    let xml = await file.async('string');

    // Name cell C6 (style 192 in template)
    xml = replaceCell(xml, 'C6', inlineStrCell('C6', '192', setup.name));

    // Currency J6 — keep template default "Euro"

    // Data rows 9–21
    for (let ri = 0; ri < ROWS_PER_SHEET; ri++) {
      const rowNum    = DATA_ROW_FIRST + ri;
      const globalIdx = si * ROWS_PER_SHEET + ri;
      const receipt   = receipts[globalIdx] ?? null;
      const globalSeq = globalIdx + 1;
      xml = replaceRow(xml, rowNum, buildDataRow(rowNum, receipt, globalSeq));
    }

    zip.file(path, xml);
  }

  // ── Fill Summary sheet ────────────────────────────────────────────────────

  const summaryFile = zip.file('xl/worksheets/sheet1.xml');
  if (summaryFile && receipts.length > 0) {
    let xml = await summaryFile.async('string');

    const sortedDates = receipts.map(r => r.date).sort();
    const dateFrom = isoToExcelSerial(sortedDates[0]);
    const dateTo   = isoToExcelSerial(sortedDates[sortedDates.length - 1]);

    // C9: Date From (style 207 in template)
    xml = replaceCell(xml, 'C9', numCell('C9', '207', dateFrom));

    // C10: Date To (style 207)
    xml = replaceCell(xml, 'C10', numCell('C10', '207', dateTo));

    // H10: Business purpose value (style 203)
    xml = replaceCell(xml, 'H10', inlineStrCell('H10', '203', setup.tripName));

    // B12: Employee name (style 192)
    xml = replaceCell(xml, 'B12', inlineStrCell('B12', '192', setup.name));

    zip.file('xl/worksheets/sheet1.xml', xml);
  }

  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
