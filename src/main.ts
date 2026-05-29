import './style.css';
import {
  loadTrips, saveTrips, nextReceiptNo,
  fmtDateDisplay, todayISO,
  CATEGORIES, CAT_LABELS, CAT_COLOURS,
  type StoredTrip, type TripSetup, type Receipt, type ExpenseCategory,
} from './data.ts';
import { generateExpenseFormXlsx } from './expense-form.ts';

// ── File loading ───────────────────────────────────────────────────────────────

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Image compression ──────────────────────────────────────────────────────────

async function compressImage(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX_W = 1200, MAX_H = 1600;
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > MAX_W || h > MAX_H) {
        const ratio = Math.min(MAX_W / w, MAX_H / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.55), width: w, height: h });
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ── PDF generation ─────────────────────────────────────────────────────────────

async function generatePDF(setup: TripSetup, rs: Receipt[]): Promise<string> {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const PW = 297;

  doc.setFillColor(10, 15, 30);
  doc.rect(0, 0, PW, 18, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(`${setup.name} — ${setup.tripName}`, 10, 11);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${new Date().toLocaleDateString('en-IE')}`, PW - 10, 11, { align: 'right' });

  const CAT_SHORT = ['Air Fares', 'Hotel', 'Meals', 'Taxis', 'Client Ent.', 'Marketing', 'PM Travel', 'Other'];
  const COL_ORDER: ExpenseCategory[] = [
    'Air Fares', 'Hotel/Lodging', 'Working Meals', 'Taxis/Transport',
    'Client Entertainment', 'Marketing/Client Travel', 'PM Travel/Sales', 'Other',
  ];

  const head = [['#', 'Date', 'Location', 'Description', ...CAT_SHORT, 'Total']];
  const body = rs.map(r => {
    const cats = COL_ORDER.map(cat => r.category === cat ? `€${r.amount.toFixed(2)}` : '');
    const desc = [setup.businessPurpose, r.nature, r.attendees ? `Attendees: ${r.attendees}` : ''].filter(Boolean).join(' — ');
    return [r.no, fmtDateDisplay(r.date), r.location, desc, ...cats, `€${r.amount.toFixed(2)}`];
  });

  const totals = COL_ORDER.map(cat =>
    rs.filter(r => r.category === cat).reduce((s, r) => s + r.amount, 0)
  );
  const grand = rs.reduce((s, r) => s + r.amount, 0);
  body.push(['', '', '', 'TOTAL', ...totals.map(t => t > 0 ? `€${t.toFixed(2)}` : ''), `€${grand.toFixed(2)}`]);

  autoTable(doc, {
    head,
    body,
    startY: 22,
    margin: { left: 8, right: 8 },
    styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [29, 78, 216], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 20 },
      2: { cellWidth: 28 },
      3: { cellWidth: 55 },
    },
    didParseCell: (data) => {
      if (data.row.index === body.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [240, 240, 240];
      }
    },
  });

  const RPW = 210, RPH = 297;
  const ACCENT: Record<ExpenseCategory, [number, number, number]> = {
    'Air Fares':               [96,  165, 250],
    'Hotel/Lodging':           [192, 132, 252],
    'Working Meals':           [74,  222, 128],
    'Taxis/Transport':         [250, 204,  21],
    'Client Entertainment':    [249, 115,  22],
    'Marketing/Client Travel': [244,  63,  94],
    'PM Travel/Sales':         [34,  211, 238],
    'Other':                   [148, 163, 184],
  };

  for (const r of rs) {
    doc.addPage('a4', 'portrait');
    const col = ACCENT[r.category] ?? [100, 100, 100];

    doc.setFillColor(...col);
    doc.rect(0, 0, RPW, 22, 'F');
    doc.setTextColor(10, 15, 30);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(`Receipt #${r.no} — ${CAT_LABELS[r.category]}`, 10, 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`${fmtDateDisplay(r.date)}  |  ${r.location}`, 10, 17);
    doc.text(`€${r.amount.toFixed(2)}`, RPW - 10, 17, { align: 'right' });

    doc.setTextColor(30, 30, 30);
    doc.setFontSize(9);
    const descText  = [setup.businessPurpose, r.nature, r.attendees ? `Attendees: ${r.attendees}` : ''].filter(Boolean).join(' — ');
    const descLines = doc.splitTextToSize(descText, RPW - 20);
    doc.text(descLines, 10, 30);
    const descEnd = 30 + descLines.length * 5;

    const IMG_MAX_W = RPW - 20, IMG_MAX_H = RPH - descEnd - 20;
    if (r.fileType === 'pdf') {
      doc.setFontSize(9);
      doc.setTextColor(150, 100, 50);
      doc.text(`[PDF attached separately: ${r.pdfFileName ?? 'document.pdf'}]`, 10, descEnd + 10);
    } else if (r.imageDataUrl) {
      const aspect = r.imageWidth / r.imageHeight;
      let iw = IMG_MAX_W, ih = iw / aspect;
      if (ih > IMG_MAX_H) { ih = IMG_MAX_H; iw = ih * aspect; }
      const ix = 10 + (IMG_MAX_W - iw) / 2;
      doc.addImage(r.imageDataUrl, 'JPEG', ix, descEnd + 5, iw, ih);
    }
  }

  return doc.output('datauristring');
}

// ── Category matching ──────────────────────────────────────────────────────────

function matchCategory(raw: string | null | undefined): ExpenseCategory | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase().trim();
  const exact = CATEGORIES.find(c => c.toLowerCase() === lower);
  if (exact) return exact;
  return CATEGORIES.find(c => lower.includes(c.split(/[\s/]/)[0].toLowerCase()));
}

// ── Theme ──────────────────────────────────────────────────────────────────────

const THEME_KEY = 'et_theme_v1';
let theme: 'dark' | 'light' = (() => {
  const s = localStorage.getItem(THEME_KEY);
  return s === 'light' ? 'light' : 'dark';
})();

function applyTheme(): void {
  document.documentElement.classList.toggle('light', theme === 'light');
}

function setTheme(t: 'dark' | 'light'): void {
  theme = t;
  localStorage.setItem(THEME_KEY, t);
  applyTheme();
  document.querySelectorAll<HTMLElement>('[data-theme]').forEach(btn => {
    btn.classList.toggle('theme-opt--active', btn.dataset['theme'] === t);
  });
}

// ── State ──────────────────────────────────────────────────────────────────────

type View = 'list' | 'setup' | 'receipts';

let trips:         StoredTrip[] = loadTrips();
let currentTripId: string | null = null;
let receipts:      Receipt[] = [];
let draft:         Partial<Receipt> & { analysing?: boolean } = {};
let editingId:     string | null = null;
let view:          View = 'list';

function tripSetup(): TripSetup | null {
  return trips.find(t => t.id === currentTripId)?.setup ?? null;
}

function persistReceipts(): void {
  const idx = trips.findIndex(t => t.id === currentTripId);
  if (idx !== -1) {
    trips[idx] = { ...trips[idx], receipts };
    saveTrips(trips);
  }
}

// ── Render ─────────────────────────────────────────────────────────────────────

function render(): void {
  const app = document.getElementById('app')!;
  if (view === 'list')       { app.innerHTML = tripsListHTML(); wireTrips();  }
  else if (view === 'setup') { app.innerHTML = setupHTML();     wireSetup();  }
  else                       { app.innerHTML = mainHTML();      wireMain();   }
}

// ── Trips list ─────────────────────────────────────────────────────────────────

function tripsListHTML(): string {
  const byCreated = (a: StoredTrip, b: StoredTrip) => b.setup.createdAt.localeCompare(a.setup.createdAt);
  const bySubmit  = (a: StoredTrip, b: StoredTrip) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? '');

  const active    = trips.filter(t => t.status === 'active').sort(byCreated);
  const submitted = trips.filter(t => t.status === 'submitted').sort(bySubmit);

  function tripCard(t: StoredTrip): string {
    const total   = t.receipts.reduce((s, r) => s + r.amount, 0);
    const dates   = t.receipts.map(r => r.date).sort();
    const dateStr = dates.length === 0 ? 'No receipts yet'
                  : dates.length === 1 ? fmtDateDisplay(dates[0])
                  : `${fmtDateDisplay(dates[0])} – ${fmtDateDisplay(dates[dates.length - 1])}`;
    const statusLabel = t.status === 'submitted' && t.submittedAt
      ? `Sent ${new Date(t.submittedAt).toLocaleDateString('en-IE', { day: '2-digit', month: 'short' })}`
      : 'Active';
    return `
      <div class="trip-card" data-trip="${t.id}">
        <div class="trip-card-main">
          <div class="trip-card-name">${t.setup.tripName}</div>
          <div class="trip-card-amount">€${total.toFixed(2)}</div>
        </div>
        <div class="trip-card-meta">
          <span class="trip-card-info">${t.receipts.length} receipt${t.receipts.length !== 1 ? 's' : ''} · ${dateStr}</span>
          <span class="trip-status trip-status--${t.status}">${statusLabel}</span>
        </div>
      </div>`;
  }

  const activeHTML    = active.length    > 0 ? `<div class="section-header">Active</div>${active.map(tripCard).join('')}`   : '';
  const submittedHTML = submitted.length > 0 ? `<div class="section-header">History</div>${submitted.map(tripCard).join('')}` : '';

  return `
    <div class="app-shell trips-screen">
      <div class="trips-scroll">
        <div class="trips-toolbar">
          <button class="icon-btn icon-btn--dim" id="btn-settings" title="Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
        <div class="trips-hero">
          <div class="trips-hero-logo">💼</div>
          <h1 class="trips-hero-title">Expense Tracker</h1>
          <p class="trips-hero-sub">Track and submit your business expenses</p>
        </div>
        <button class="new-trip-btn" id="btn-new-trip">
          <div class="new-trip-btn-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </div>
          <div class="new-trip-btn-body">
            <span class="new-trip-btn-label">New Trip</span>
            <span class="new-trip-btn-hint">Start tracking your expenses</span>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.35;flex-shrink:0">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
        ${activeHTML}${submittedHTML}
      </div>

      <div class="sheet-overlay" id="settings-overlay" hidden></div>
      <div class="sheet" id="settings-sheet" hidden>
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title">Settings</span>
          <button class="sheet-close" id="settings-close">✕</button>
        </div>
        <div class="sheet-body">
          <div class="settings-group">
            <div class="settings-group-title">Appearance</div>
            <div class="settings-row">
              <span class="settings-label">Theme</span>
              <div class="theme-seg">
                <button class="theme-opt${theme === 'light' ? ' theme-opt--active' : ''}" data-theme="light">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <circle cx="12" cy="12" r="5"/>
                    <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                    <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                  </svg>
                  Light
                </button>
                <button class="theme-opt${theme === 'dark' ? ' theme-opt--active' : ''}" data-theme="dark">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                  Dark
                </button>
              </div>
            </div>
          </div>
          <div class="settings-group">
            <div class="settings-group-title">Data</div>
            <button class="settings-danger-row" id="btn-clear-data">
              <div>
                <div class="settings-danger-label">Clear All Data</div>
                <div class="settings-danger-hint">Delete all trips and receipts from this device</div>
              </div>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:0.7">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div class="confirm-overlay" id="confirm-overlay" hidden>
        <div class="confirm-card">
          <div class="confirm-title">Clear All Data?</div>
          <div class="confirm-body">This will permanently delete all trips and receipts from this device. This cannot be undone.</div>
          <div class="confirm-btns">
            <button class="confirm-cancel" id="confirm-cancel">Cancel</button>
            <button class="confirm-ok" id="confirm-ok">Clear Everything</button>
          </div>
        </div>
      </div>

      <div class="toast" id="toast" hidden></div>
    </div>`;
}

function wireTrips(): void {
  document.getElementById('btn-new-trip')!.addEventListener('click', () => {
    view = 'setup';
    render();
  });
  document.getElementById('btn-settings')!.addEventListener('click', openSettings);
  document.querySelectorAll<HTMLElement>('[data-trip]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset['trip']!;
      currentTripId = id;
      receipts = [...trips.find(t => t.id === id)!.receipts];
      editingId = null;
      draft = {};
      view = 'receipts';
      render();
    });
  });
}

// ── Settings sheet ─────────────────────────────────────────────────────────────

function openSettings(): void {
  const overlay = document.getElementById('settings-overlay')!;
  const sheet   = document.getElementById('settings-sheet')!;
  overlay.hidden = false;
  sheet.hidden   = false;
  requestAnimationFrame(() => sheet.classList.add('sheet--open'));
  overlay.addEventListener('click', closeSettings, { once: true });
  document.getElementById('settings-close')!.addEventListener('click', closeSettings);

  document.querySelectorAll<HTMLElement>('[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset['theme'] as 'dark' | 'light'));
  });

  document.getElementById('btn-clear-data')!.addEventListener('click', () => {
    const confirm = document.getElementById('confirm-overlay')!;
    confirm.hidden = false;
    document.getElementById('confirm-cancel')!.addEventListener('click', () => { confirm.hidden = true; });
    document.getElementById('confirm-ok')!.addEventListener('click', () => {
      localStorage.clear();
      trips = [];
      theme = 'dark';
      applyTheme();
      view = 'list';
      render();
    });
  });
}

function closeSettings(): void {
  const sheet = document.getElementById('settings-sheet')!;
  sheet.classList.remove('sheet--open');
  sheet.addEventListener('transitionend', () => {
    sheet.hidden = true;
    document.getElementById('settings-overlay')!.hidden = true;
  }, { once: true });
}

// ── Setup screen ───────────────────────────────────────────────────────────────

function setupHTML(): string {
  const lastSetup = [...trips].sort((a, b) => b.setup.createdAt.localeCompare(a.setup.createdAt))[0]?.setup;

  return `
    <div class="setup-screen">
      <div class="setup-card">
        <button class="setup-back" id="btn-back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          All Trips
        </button>
        <div class="setup-logo">💼</div>
        <h1 class="setup-title">New Trip</h1>
        <p class="setup-sub">Enter your details to start tracking expenses</p>
        <div class="setup-form">
          <div class="field-group">
            <label class="field-label">Your Name</label>
            <input class="field-input" id="inp-name" type="text" placeholder="e.g. Jane Smith" autocomplete="name" value="${lastSetup?.name ?? ''}" />
          </div>
          <div class="field-group">
            <label class="field-label">Email Address</label>
            <input class="field-input" id="inp-email" type="email" placeholder="you@example.com" autocomplete="email" value="${lastSetup?.email ?? ''}" />
          </div>
          <div class="field-group">
            <label class="field-label">Trip Name</label>
            <input class="field-input" id="inp-trip" type="text" placeholder="e.g. Paris Feb 2026" />
          </div>
          <div class="field-group">
            <label class="field-label">Business Purpose of Travel</label>
            <input class="field-input" id="inp-purpose" type="text" placeholder="e.g. Client meetings, Conference" />
          </div>
          <button class="btn-primary" id="btn-start">Start Trip</button>
        </div>
      </div>
    </div>`;
}

function wireSetup(): void {
  document.getElementById('btn-back')?.addEventListener('click', () => {
    view = 'list';
    render();
  });

  document.getElementById('btn-start')!.addEventListener('click', () => {
    const name            = (document.getElementById('inp-name')    as HTMLInputElement).value.trim();
    const email           = (document.getElementById('inp-email')   as HTMLInputElement).value.trim();
    const tripName        = (document.getElementById('inp-trip')    as HTMLInputElement).value.trim();
    const businessPurpose = (document.getElementById('inp-purpose') as HTMLInputElement).value.trim();
    if (!name || !email || !tripName || !businessPurpose) { showToast('Please fill in all fields'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Enter a valid email address'); return; }

    const newTrip: StoredTrip = {
      id:       crypto.randomUUID(),
      setup:    { name, email, tripName, businessPurpose, createdAt: new Date().toISOString() },
      receipts: [],
      status:   'active',
    };
    trips.push(newTrip);
    saveTrips(trips);

    currentTripId = newTrip.id;
    receipts = [];
    editingId = null;
    draft = {};
    view = 'receipts';
    render();
  });

  ['inp-name', 'inp-email', 'inp-trip', 'inp-purpose'].forEach(id => {
    document.getElementById(id)!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') document.getElementById('btn-start')!.click();
    });
  });
}

// ── Main screen (receipts view) ────────────────────────────────────────────────

function mainHTML(): string {
  const setup  = tripSetup()!;
  const total  = receipts.reduce((s, r) => s + r.amount, 0);
  const sorted = [...receipts].sort((a, b) => b.no - a.no);

  const listHTML = sorted.length === 0
    ? `<div class="empty-state">
         <div class="empty-icon">🧾</div>
         <p>No receipts yet.<br>Tap + to add your first one.</p>
       </div>`
    : sorted.map(r => {
        const col = CAT_COLOURS[r.category];
        const thumbHTML = r.fileType === 'pdf'
          ? `<div class="receipt-thumb receipt-thumb--pdf"><span>PDF</span></div>`
          : `<div class="receipt-thumb"><img src="${r.imageDataUrl}" alt="Receipt ${r.no}" /></div>`;
        return `
          <div class="receipt-row" data-edit="${r.id}">
            ${thumbHTML}
            <div class="receipt-info">
              <div class="receipt-top">
                <span class="receipt-no">#${r.no}</span>
                <span class="receipt-date">${fmtDateDisplay(r.date)}</span>
              </div>
              <div class="receipt-loc">${r.location}</div>
              ${r.nature ? `<div class="receipt-nature">${r.nature}</div>` : ''}
              <span class="receipt-cat" style="color:${col.text};background:${col.bg}">${CAT_LABELS[r.category]}</span>
            </div>
            <div class="receipt-amount">€${r.amount.toFixed(2)}</div>
          </div>`;
      }).join('');

  return `
    <div class="app-shell">
      <header class="top-bar">
        <div class="top-bar-inner">
          <button class="icon-btn icon-btn--dim" id="btn-back" title="All Trips">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <div class="top-bar-title">${setup.tripName}</div>
          <div class="top-bar-actions">
            <button class="icon-btn icon-btn--dim" id="btn-delete" title="Delete Trip">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
            <button class="icon-btn" id="btn-send" title="Send Report">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div class="summary-card">
        <div class="summary-row">
          <div class="summary-stat">
            <span class="summary-val">${receipts.length}</span>
            <span class="summary-lbl">Receipts</span>
          </div>
          <div class="summary-divider"></div>
          <div class="summary-stat">
            <span class="summary-val">€${total.toFixed(2)}</span>
            <span class="summary-lbl">Total</span>
          </div>
          <div class="summary-divider"></div>
          <div class="summary-stat">
            <span class="summary-val">${setup.name.split(' ')[0]}</span>
            <span class="summary-lbl">Traveller</span>
          </div>
        </div>
      </div>

      <div class="receipt-list" id="receipt-list">
        ${listHTML}
      </div>

      <button class="fab" id="btn-add">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
    </div>

    <div class="sheet-overlay" id="sheet-overlay" hidden></div>
    <div class="sheet" id="sheet" hidden></div>
    <div class="send-overlay" id="send-overlay" hidden>
      <div class="send-card">
        <div class="send-spinner"></div>
        <div class="send-msg" id="send-msg">Generating report…</div>
      </div>
    </div>
    <div class="confirm-overlay" id="confirm-overlay" hidden>
      <div class="confirm-card">
        <div class="confirm-title">Delete Trip?</div>
        <div class="confirm-body">This will permanently delete this trip and all its receipts. This cannot be undone.</div>
        <div class="confirm-btns">
          <button class="confirm-cancel" id="confirm-cancel">Cancel</button>
          <button class="confirm-ok" id="confirm-ok">Delete</button>
        </div>
      </div>
    </div>
    <div class="toast" id="toast" hidden></div>`;
}

function wireMain(): void {
  document.getElementById('btn-back')!.addEventListener('click', () => {
    view = 'list';
    render();
  });
  document.getElementById('btn-add')!.addEventListener('click', () => openSheet(null));
  document.getElementById('btn-send')!.addEventListener('click', sendReport);
  document.getElementById('btn-delete')!.addEventListener('click', confirmDeleteTrip);

  document.querySelectorAll<HTMLElement>('[data-edit]').forEach(el => {
    el.addEventListener('click', () => openSheet(el.dataset['edit']!));
  });
}

// ── Bottom sheet ───────────────────────────────────────────────────────────────

function openSheet(id: string | null): void {
  editingId = id;
  const existing = id ? receipts.find(r => r.id === id) : null;
  draft = existing ? { ...existing } : { date: todayISO(), imageDataUrl: '' };
  renderSheet();

  const overlay = document.getElementById('sheet-overlay')!;
  const sheet   = document.getElementById('sheet')!;
  overlay.hidden = false;
  sheet.hidden   = false;
  requestAnimationFrame(() => sheet.classList.add('sheet--open'));

  overlay.addEventListener('click', closeSheet, { once: true });
}

function closeSheet(): void {
  const sheet = document.getElementById('sheet')!;
  sheet.classList.remove('sheet--open');
  sheet.addEventListener('transitionend', () => {
    document.getElementById('sheet')!.hidden = true;
    document.getElementById('sheet-overlay')!.hidden = true;
  }, { once: true });
}

function renderSheet(): void {
  const sheet = document.getElementById('sheet')!;
  sheet.innerHTML = sheetHTML();
  wireSheet();
}

function sheetHTML(): string {
  const isPdf   = draft.fileType === 'pdf';
  const hasFile = isPdf ? !!draft.pdfDataUrl : !!draft.imageDataUrl;
  const catButtons = CATEGORIES.map(cat => {
    const col    = CAT_COLOURS[cat];
    const active = draft.category === cat;
    return `<button class="cat-pill${active ? ' cat-pill--active' : ''}" data-cat="${cat}"
      style="color:${col.text};background:${active ? col.bg : 'transparent'};border-color:${col.text}40">
      ${CAT_LABELS[cat]}
    </button>`;
  }).join('');

  return `
    <div class="sheet-handle"></div>
    <div class="sheet-header">
      <span class="sheet-title">${editingId ? 'Edit Receipt' : 'Add Receipt'}</span>
      <button class="sheet-close" id="sheet-close">✕</button>
    </div>
    <div class="sheet-body">
      <div class="photo-zone" id="photo-zone">
        ${isPdf
          ? `<div class="photo-pdf-badge">
               <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="1.5">
                 <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                 <polyline points="14 2 14 8 20 8"/>
                 <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                 <polyline points="10 9 9 9 8 9"/>
               </svg>
               <span class="photo-pdf-name">${draft.pdfFileName ?? 'Document attached'}</span>
               <span class="photo-pdf-hint">Tap to replace</span>
             </div>`
          : hasFile
            ? `<img class="photo-preview" src="${draft.imageDataUrl}" alt="Receipt" />`
            : `<div class="photo-placeholder">
                 <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#4a5568" stroke-width="1.5">
                   <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                   <circle cx="12" cy="13" r="4"/>
                 </svg>
                 <span>Photo, screenshot, or PDF</span>
               </div>`
        }
        ${draft.analysing
          ? `<div class="photo-analysing-overlay">
               <div class="photo-spin"></div>
               <span>Reading receipt…</span>
             </div>`
          : ''
        }
        <input type="file" accept="image/*,application/pdf" id="photo-input" class="photo-input" ${draft.analysing ? 'disabled' : ''} />
      </div>

      <div class="field-group">
        <label class="field-label">Date</label>
        <input class="field-input" id="inp-date" type="date" value="${draft.date ?? todayISO()}" />
      </div>
      <div class="field-group">
        <label class="field-label">Location</label>
        <input class="field-input" id="inp-location" type="text" list="location-list" placeholder="City or venue" value="${draft.location ?? ''}" autocomplete="off" />
        <datalist id="location-list">
          ${[...new Set(receipts.map(r => r.location).filter(Boolean))].map(l => `<option value="${l}"></option>`).join('')}
        </datalist>
      </div>
      <div class="field-group">
        <label class="field-label">Nature of Expenditure</label>
        <input class="field-input" id="inp-nature" type="text" placeholder="e.g. Dinner with client, Taxi to airport" value="${draft.nature ?? ''}" />
      </div>
      ${draft.category === 'Working Meals' || draft.category === 'Client Entertainment' ? `
      <div class="field-group attendees-field">
        <label class="field-label">Attendees <span class="field-label-req">required</span></label>
        <input class="field-input" id="inp-attendees" type="text" placeholder="e.g. Jane Smith (Acme), John Doe (Client)" value="${draft.attendees ?? ''}" />
      </div>` : ''}
      <div class="field-group">
        <label class="field-label">Category</label>
        <div class="cat-grid" id="cat-grid">${catButtons}</div>
      </div>
      <div class="field-group">
        <label class="field-label">Amount (€)</label>
        <input class="field-input" id="inp-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" value="${draft.amount != null ? draft.amount : ''}" />
      </div>

      <div class="sheet-actions">
        ${editingId ? `<button class="btn-danger" id="btn-delete-receipt">Delete</button>` : ''}
        <button class="btn-primary" id="btn-save">${editingId ? 'Save Changes' : 'Add Receipt'}</button>
      </div>
    </div>`;
}

function wireSheet(): void {
  document.getElementById('sheet-close')!.addEventListener('click', closeSheet);

  const photoInput = document.getElementById('photo-input') as HTMLInputElement;

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    if (!file) return;

    if (file.type === 'application/pdf') {
      const dataUrl     = await readFileAsDataUrl(file);
      draft.fileType    = 'pdf';
      draft.pdfDataUrl  = dataUrl;
      draft.pdfFileName = file.name;
      draft.imageDataUrl = '';
      draft.imageWidth   = 0;
      draft.imageHeight  = 0;
    } else {
      const result       = await compressImage(file);
      draft.fileType     = 'image';
      draft.imageDataUrl = result.dataUrl;
      draft.imageWidth   = result.width;
      draft.imageHeight  = result.height;
      draft.pdfDataUrl   = undefined;
      draft.pdfFileName  = undefined;
    }

    draft.analysing = true;
    renderSheet();
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    try {
      const body = draft.fileType === 'pdf'
        ? { pdfBase64: draft.pdfDataUrl!.split(',')[1] }
        : { imageBase64: draft.imageDataUrl!.split(',')[1], mediaType: 'image/jpeg' };

      const res  = await fetch('/api/analyse-receipt', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json();

      if (res.ok) {
        if (data.date)     draft.date     = data.date;
        if (data.amount)   draft.amount   = data.amount;
        if (data.location) draft.location = data.location;
        if (data.nature)   draft.nature   = data.nature;
        const cat = matchCategory(data.category);
        if (cat) draft.category = cat;
      } else {
        showToast(data.error === 'API key not configured'
          ? 'AI analysis not set up — fill in fields manually'
          : 'Could not read receipt — fill in manually');
      }
    } catch {
      showToast('Could not read receipt — fill in manually');
    }

    draft.analysing = false;
    renderSheet();
  });

  document.getElementById('inp-date')!.addEventListener('change', (e) => {
    draft.date = (e.target as HTMLInputElement).value;
  });
  document.getElementById('inp-location')!.addEventListener('input', (e) => {
    draft.location = (e.target as HTMLInputElement).value;
  });
  document.getElementById('inp-nature')!.addEventListener('input', (e) => {
    draft.nature = (e.target as HTMLInputElement).value;
  });
  document.getElementById('inp-attendees')?.addEventListener('input', (e) => {
    draft.attendees = (e.target as HTMLInputElement).value;
  });
  document.getElementById('inp-amount')!.addEventListener('input', (e) => {
    draft.amount = parseFloat((e.target as HTMLInputElement).value) || 0;
  });

  document.getElementById('cat-grid')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-cat]') as HTMLElement;
    if (!btn) return;
    draft.category = btn.dataset['cat'] as ExpenseCategory;
    renderSheet();
  });

  document.getElementById('btn-save')!.addEventListener('click', saveReceipt);
  document.getElementById('btn-delete-receipt')?.addEventListener('click', deleteReceipt);
}

function saveReceipt(): void {
  const date     = (document.getElementById('inp-date')     as HTMLInputElement).value;
  const location = (document.getElementById('inp-location') as HTMLInputElement).value.trim();
  const nature   = (document.getElementById('inp-nature')   as HTMLInputElement).value.trim();
  const amount   = parseFloat((document.getElementById('inp-amount') as HTMLInputElement).value);

  const attendees  = (document.getElementById('inp-attendees') as HTMLInputElement | null)?.value.trim() ?? draft.attendees ?? '';
  const needsAttendees = draft.category === 'Working Meals' || draft.category === 'Client Entertainment';

  if (!date)                        { showToast('Please enter a date');          return; }
  if (!location)                    { showToast('Please enter a location');       return; }
  if (!draft.category)              { showToast('Please select a category');      return; }
  if (isNaN(amount) || amount <= 0) { showToast('Please enter a valid amount');  return; }
  if (needsAttendees && !attendees) { showToast('Please list who attended');      return; }
  const hasFile = draft.fileType === 'pdf' ? !!draft.pdfDataUrl : !!draft.imageDataUrl;
  if (!hasFile) { showToast('Please attach a receipt or document'); return; }

  const fileFields = {
    fileType:     draft.fileType ?? 'image',
    imageDataUrl: draft.imageDataUrl ?? '',
    imageWidth:   draft.imageWidth   ?? 0,
    imageHeight:  draft.imageHeight  ?? 0,
    pdfDataUrl:   draft.pdfDataUrl,
    pdfFileName:  draft.pdfFileName,
  };

  if (editingId) {
    const idx = receipts.findIndex(r => r.id === editingId);
    if (idx !== -1) {
      receipts[idx] = { ...receipts[idx], date, location, nature, attendees: attendees || undefined, category: draft.category!, amount, ...fileFields };
    }
  } else {
    const newReceipt: Receipt = {
      id: crypto.randomUUID(), no: nextReceiptNo(receipts),
      date, location, nature, attendees: attendees || undefined, category: draft.category!, amount,
      ...fileFields,
    };
    receipts.push(newReceipt);
  }

  persistReceipts();
  closeSheet();
  setTimeout(() => { render(); showToast(editingId ? 'Receipt updated' : 'Receipt added'); }, 300);
}

function deleteReceipt(): void {
  if (!editingId) return;
  receipts = receipts.filter(r => r.id !== editingId);
  persistReceipts();
  closeSheet();
  setTimeout(() => { render(); showToast('Receipt deleted'); }, 300);
}

// ── Delete trip confirmation ────────────────────────────────────────────────────

function confirmDeleteTrip(): void {
  const overlay = document.getElementById('confirm-overlay')!;
  overlay.hidden = false;
  document.getElementById('confirm-cancel')!.addEventListener('click', () => { overlay.hidden = true; });
  document.getElementById('confirm-ok')!.addEventListener('click', () => {
    trips = trips.filter(t => t.id !== currentTripId);
    saveTrips(trips);
    currentTripId = null;
    receipts = [];
    view = 'list';
    render();
    showToast('Trip deleted');
  });
}

// ── Send report ────────────────────────────────────────────────────────────────

async function sendReport(): Promise<void> {
  const setup = tripSetup();
  if (!setup) return;
  if (receipts.length === 0) { showToast('No receipts to send'); return; }

  const overlay = document.getElementById('send-overlay')!;
  const msg     = document.getElementById('send-msg')!;
  overlay.hidden = false;

  try {
    msg.textContent = 'Generating PDF…';
    const pdfDataUri = await generatePDF(setup, receipts);
    const pdfBase64  = pdfDataUri.split(',')[1];

    msg.textContent = 'Generating expense form…';
    const xlsxBase64 = await generateExpenseFormXlsx(setup, receipts);

    const pdfAttachments = receipts
      .filter(r => r.fileType === 'pdf' && r.pdfDataUrl)
      .map(r => ({
        filename: r.pdfFileName ?? `receipt_${r.no}.pdf`,
        base64:   r.pdfDataUrl!.split(',')[1],
      }));

    msg.textContent = 'Sending email…';
    const res = await fetch('/api/send-report', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        to:        setup.email,
        name:      setup.name,
        tripName:  setup.tripName,
        pdfBase64,
        xlsxBase64,
        pdfAttachments,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error ?? `HTTP ${res.status}`);
    }

    // Mark trip as submitted and navigate to history
    const idx = trips.findIndex(t => t.id === currentTripId);
    if (idx !== -1) {
      trips[idx] = { ...trips[idx], status: 'submitted', submittedAt: new Date().toISOString() };
      saveTrips(trips);
    }

    overlay.hidden = true;
    view = 'list';
    render();
    showToast('Report sent! Check your inbox.');
  } catch (e) {
    overlay.hidden = true;
    showToast(`Failed: ${(e as Error).message}`);
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────────

function showToast(msg: string): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  toast.classList.add('toast--show');
  const duration = msg.length > 60 ? 5500 : 2800;
  setTimeout(() => {
    toast.classList.remove('toast--show');
    setTimeout(() => { toast.hidden = true; }, 300);
  }, duration);
}

// ── Boot ───────────────────────────────────────────────────────────────────────

applyTheme();
render();
