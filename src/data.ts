export interface TripSetup {
  name:            string;   // person's name (for report header)
  email:           string;   // where to send the report
  tripName:        string;   // reference label e.g. "Paris Feb 2026"
  businessPurpose: string;   // used in every CSV row's "Business Purpose & Details" column
  createdAt:       string;
}

export interface Receipt {
  id:            string;
  no:            number;
  date:          string;  // YYYY-MM-DD
  location:      string;
  nature:        string;  // Nature of expenditure — what was bought
  category:      ExpenseCategory;
  amount:        number;
  imageDataUrl:  string;  // compressed JPEG base64 (or empty string when fileType=pdf)
  imageWidth:    number;
  imageHeight:   number;
  fileType?:     'image' | 'pdf';
  pdfDataUrl?:   string;  // base64 PDF when fileType=pdf
  pdfFileName?:  string;
}

// Maps directly to Excel columns A–H
export type ExpenseCategory =
  | 'Air Fares'
  | 'Hotel/Lodging'
  | 'Working Meals'
  | 'Taxis/Transport'
  | 'Client Entertainment'
  | 'Marketing/Client Travel'
  | 'PM Travel/Sales'
  | 'Other';

export const CATEGORIES: ExpenseCategory[] = [
  'Air Fares', 'Hotel/Lodging', 'Working Meals', 'Taxis/Transport',
  'Client Entertainment', 'Marketing/Client Travel', 'PM Travel/Sales', 'Other',
];

// Short labels for the category grid pills
export const CAT_LABELS: Record<ExpenseCategory, string> = {
  'Air Fares':              'Air Fares',
  'Hotel/Lodging':          'Hotel',
  'Working Meals':          'Meals',
  'Taxis/Transport':        'Taxis',
  'Client Entertainment':   'Client Ent.',
  'Marketing/Client Travel':'Marketing',
  'PM Travel/Sales':        'PM Travel',
  'Other':                  'Other',
};

export const CAT_COLOURS: Record<ExpenseCategory, { text: string; bg: string }> = {
  'Air Fares':              { text: '#60a5fa', bg: 'rgba(29,78,216,0.25)' },
  'Hotel/Lodging':          { text: '#c084fc', bg: 'rgba(126,34,206,0.25)' },
  'Working Meals':          { text: '#4ade80', bg: 'rgba(21,128,61,0.25)' },
  'Taxis/Transport':        { text: '#facc15', bg: 'rgba(161,98,7,0.25)' },
  'Client Entertainment':   { text: '#f97316', bg: 'rgba(194,65,12,0.25)' },
  'Marketing/Client Travel':{ text: '#f43f5e', bg: 'rgba(190,18,60,0.25)' },
  'PM Travel/Sales':        { text: '#22d3ee', bg: 'rgba(14,116,144,0.25)' },
  'Other':                  { text: '#94a3b8', bg: 'rgba(71,85,105,0.25)' },
};

// ── localStorage ─────────────────────────────────────────────────────────────

const TRIP_KEY    = 'et_trip_v1';
const RECEIPT_KEY = 'et_receipts_v1';

export function loadTrip(): TripSetup | null {
  try { return JSON.parse(localStorage.getItem(TRIP_KEY) ?? 'null'); }
  catch { return null; }
}

export function saveTrip(t: TripSetup): void {
  localStorage.setItem(TRIP_KEY, JSON.stringify(t));
}

export function clearTrip(): void {
  localStorage.removeItem(TRIP_KEY);
  localStorage.removeItem(RECEIPT_KEY);
}

export function loadReceipts(): Receipt[] {
  try { return JSON.parse(localStorage.getItem(RECEIPT_KEY) ?? '[]'); }
  catch { return []; }
}

export function saveReceipts(r: Receipt[]): void {
  localStorage.setItem(RECEIPT_KEY, JSON.stringify(r));
}

export function nextReceiptNo(receipts: Receipt[]): number {
  return receipts.length === 0 ? 1 : Math.max(...receipts.map(r => r.no)) + 1;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function fmtDateDisplay(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-IE', { day: '2-digit', month: 'short', year: '2-digit' });
}

export function fmtDateCSV(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  const dd  = String(d.getDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const yy  = String(d.getFullYear()).slice(2);
  return `${dd}-${mon}-${yy}`;
}

export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── CSV export ────────────────────────────────────────────────────────────────

const CSV_HEADER = [
  'Receipt No.', 'Date', 'Location', 'Business Purpose & Details',
  'Air Fares (A)', 'Hotel/Lodging (B)', 'Working Meals (C)',
  'Taxis/Rail/Bus/Car Hire/Mileage (D)', 'Client Entertainment (E)',
  'Marketing Related/Client Travel (F)', 'PM Travel Supporting Sales (G)',
  'Other (H)', 'Total',
].join(',');

const COL_ORDER: ExpenseCategory[] = [
  'Air Fares', 'Hotel/Lodging', 'Working Meals', 'Taxis/Transport',
  'Client Entertainment', 'Marketing/Client Travel', 'PM Travel/Sales', 'Other',
];

function esc(s: string | number): string {
  const str = String(s);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

export function generateCSV(setup: TripSetup, receipts: Receipt[]): string {
  const rows = receipts.map(r => {
    const cols = COL_ORDER.map(cat => r.category === cat ? r.amount.toFixed(2) : '');
    const desc = [setup.businessPurpose, r.nature].filter(Boolean).join(' — ');
    return [r.no, fmtDateCSV(r.date), esc(r.location), esc(desc), ...cols, r.amount.toFixed(2)].join(',');
  });

  const totals = COL_ORDER.map(cat =>
    receipts.filter(r => r.category === cat).reduce((s, r) => s + r.amount, 0)
  );
  const grandTotal = receipts.reduce((s, r) => s + r.amount, 0);
  const totRow = ['', '', '', 'TOTAL BASE CURRENCY', ...totals.map(t => t > 0 ? t.toFixed(2) : ''), grandTotal.toFixed(2)].join(',');

  return [
    `Name: ${setup.name}`,
    `Trip: ${setup.tripName}`,
    '',
    CSV_HEADER,
    ...rows,
    totRow,
  ].join('\n');
}
