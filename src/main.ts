import './style.css';
import {
  loadTrip, saveTrip, clearTrip,
  loadReceipts, saveReceipts, nextReceiptNo,
  generateCSV,
  fmtDateDisplay, todayISO,
  CATEGORIES, CAT_LABELS, CAT_COLOURS,
  type TripSetup, type Receipt, type ExpenseCategory,
} from './data.ts';

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

async function generatePDF(setup: TripSetup, receipts: Receipt[]): Promise<string> {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  // ── Summary page (landscape A4) ──────────────────────────────────────────────
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const PW = 297;

  // Header band
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
  const body = receipts.map(r => {
    const cats = COL_ORDER.map(cat => r.category === cat ? `€${r.amount.toFixed(2)}` : '');
    return [r.no, fmtDateDisplay(r.date), r.location, setup.businessPurpose, ...cats, `€${r.amount.toFixed(2)}`];
  });

  const totals = COL_ORDER.map(cat =>
    receipts.filter(r => r.category === cat).reduce((s, r) => s + r.amount, 0)
  );
  const grand = receipts.reduce((s, r) => s + r.amount, 0);
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

  // ── Receipt pages (portrait A4) ──────────────────────────────────────────────
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

  for (const r of receipts) {
    doc.addPage('a4', 'portrait');

    const col = ACCENT[r.category] ?? [100, 100, 100];

    // Header strip
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

    // Business purpose (trip-level, same for all receipts)
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(9);
    const descLines = doc.splitTextToSize(setup.businessPurpose, RPW - 20);
    doc.text(descLines, 10, 30);
    const descEnd = 30 + descLines.length * 5;

    // Receipt image or PDF note
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

// ── State ──────────────────────────────────────────────────────────────────────

let trip = loadTrip();
let receipts = loadReceipts();
let draft: Partial<Receipt> & { imageDataUrl?: string } = {};
let editingId: string | null = null;
// ── Render ─────────────────────────────────────────────────────────────────────

function render(): void {
  document.getElementById('app')!.innerHTML = trip ? mainHTML() : setupHTML();
  if (trip) wireMain(); else wireSetup();
}

// ── Setup screen ───────────────────────────────────────────────────────────────

function setupHTML(): string {
  return `
    <div class="setup-screen">
      <div class="setup-card">
        <div class="setup-logo">💼</div>
        <h1 class="setup-title">Expense Tracker</h1>
        <p class="setup-sub">Set up your trip to get started</p>
        <div class="setup-form">
          <div class="field-group">
            <label class="field-label">Your Name</label>
            <input class="field-input" id="inp-name" type="text" placeholder="e.g. Kevin Breen" autocomplete="name" />
          </div>
          <div class="field-group">
            <label class="field-label">Email Address</label>
            <input class="field-input" id="inp-email" type="email" placeholder="you@example.com" autocomplete="email" />
          </div>
          <div class="field-group">
            <label class="field-label">Trip Name</label>
            <input class="field-input" id="inp-trip" type="text" placeholder="e.g. Paris Feb 2026" />
          </div>
          <div class="field-group">
            <label class="field-label">Business Purpose &amp; Details</label>
            <textarea class="field-input field-textarea" id="inp-purpose" placeholder="e.g. Client site visits and meetings"></textarea>
          </div>
          <button class="btn-primary" id="btn-start">Start Trip</button>
        </div>
      </div>
    </div>`;
}

function wireSetup(): void {
  document.getElementById('btn-start')!.addEventListener('click', () => {
    const name            = (document.getElementById('inp-name')    as HTMLInputElement).value.trim();
    const email           = (document.getElementById('inp-email')   as HTMLInputElement).value.trim();
    const tripName        = (document.getElementById('inp-trip')    as HTMLInputElement).value.trim();
    const businessPurpose = (document.getElementById('inp-purpose') as HTMLTextAreaElement).value.trim();
    if (!name || !email || !tripName || !businessPurpose) { showToast('Please fill in all fields'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Enter a valid email address'); return; }
    trip = { name, email, tripName, businessPurpose, createdAt: new Date().toISOString() };
    saveTrip(trip);
    render();
  });

  ['inp-name','inp-email','inp-trip'].forEach(id => {
    document.getElementById(id)!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') document.getElementById('btn-start')!.click();
    });
  });
}

// ── Main screen ────────────────────────────────────────────────────────────────

function mainHTML(): string {
  const total = receipts.reduce((s, r) => s + r.amount, 0);
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
              <span class="receipt-cat" style="color:${col.text};background:${col.bg}">${CAT_LABELS[r.category]}</span>
            </div>
            <div class="receipt-amount">€${r.amount.toFixed(2)}</div>
          </div>`;
      }).join('');

  return `
    <div class="app-shell">
      <header class="top-bar">
        <div class="top-bar-inner">
          <div class="top-bar-title">${trip!.tripName}</div>
          <div class="top-bar-actions">
            <button class="icon-btn" id="btn-send" title="Send Report">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
            <button class="icon-btn icon-btn--dim" id="btn-new-trip" title="New Trip">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
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
            <span class="summary-val">${trip!.name.split(' ')[0]}</span>
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
        <div class="confirm-title">Start a New Trip?</div>
        <div class="confirm-body">This will clear all current receipts and trip data. This cannot be undone.</div>
        <div class="confirm-btns">
          <button class="confirm-cancel" id="confirm-cancel">Cancel</button>
          <button class="confirm-ok" id="confirm-ok">Clear &amp; Start New</button>
        </div>
      </div>
    </div>
    <div class="toast" id="toast" hidden></div>`;
}

function wireMain(): void {
  document.getElementById('btn-add')!.addEventListener('click', () => openSheet(null));
  document.getElementById('btn-send')!.addEventListener('click', sendReport);
  document.getElementById('btn-new-trip')!.addEventListener('click', confirmNewTrip);

  document.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('click', () => openSheet((el as HTMLElement).dataset['edit']!));
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
    const col = CAT_COLOURS[cat];
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
        <input type="file" accept="image/*,application/pdf" id="photo-input" class="photo-input" />
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
        <label class="field-label">Category</label>
        <div class="cat-grid" id="cat-grid">${catButtons}</div>
      </div>
      <div class="field-group">
        <label class="field-label">Amount (€)</label>
        <input class="field-input" id="inp-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" value="${draft.amount != null ? draft.amount : ''}" />
      </div>

      <div class="sheet-actions">
        ${editingId ? `<button class="btn-danger" id="btn-delete">Delete</button>` : ''}
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
      const dataUrl = await readFileAsDataUrl(file);
      draft.fileType    = 'pdf';
      draft.pdfDataUrl  = dataUrl;
      draft.pdfFileName = file.name;
      draft.imageDataUrl = '';
      draft.imageWidth   = 0;
      draft.imageHeight  = 0;
    } else {
      const result = await compressImage(file);
      draft.fileType    = 'image';
      draft.imageDataUrl = result.dataUrl;
      draft.imageWidth   = result.width;
      draft.imageHeight  = result.height;
      draft.pdfDataUrl   = undefined;
      draft.pdfFileName  = undefined;
    }
    renderSheet();
  });

  document.getElementById('inp-date')!.addEventListener('change', (e) => {
    draft.date = (e.target as HTMLInputElement).value;
  });
  document.getElementById('inp-location')!.addEventListener('input', (e) => {
    draft.location = (e.target as HTMLInputElement).value;
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
  document.getElementById('btn-delete')?.addEventListener('click', deleteReceipt);
}

function saveReceipt(): void {
  const date     = (document.getElementById('inp-date')     as HTMLInputElement).value;
  const location = (document.getElementById('inp-location') as HTMLInputElement).value.trim();
  const amount   = parseFloat((document.getElementById('inp-amount') as HTMLInputElement).value);

  if (!date)                        { showToast('Please enter a date');          return; }
  if (!location)                    { showToast('Please enter a location');       return; }
  if (!draft.category)              { showToast('Please select a category');      return; }
  if (isNaN(amount) || amount <= 0) { showToast('Please enter a valid amount');  return; }
  const hasFile = draft.fileType === 'pdf' ? !!draft.pdfDataUrl : !!draft.imageDataUrl;
  if (!hasFile) { showToast('Please attach a receipt or document'); return; }

  const fileFields = {
    fileType:    draft.fileType ?? 'image',
    imageDataUrl: draft.imageDataUrl ?? '',
    imageWidth:   draft.imageWidth   ?? 0,
    imageHeight:  draft.imageHeight  ?? 0,
    pdfDataUrl:   draft.pdfDataUrl,
    pdfFileName:  draft.pdfFileName,
  };

  if (editingId) {
    const idx = receipts.findIndex(r => r.id === editingId);
    if (idx !== -1) {
      receipts[idx] = { ...receipts[idx], date, location, category: draft.category!, amount, ...fileFields };
    }
  } else {
    const newReceipt: Receipt = {
      id: crypto.randomUUID(), no: nextReceiptNo(receipts),
      date, location, category: draft.category!, amount,
      ...fileFields,
    };
    receipts.push(newReceipt);
  }

  saveReceipts(receipts);
  closeSheet();
  setTimeout(() => { render(); showToast(editingId ? 'Receipt updated' : 'Receipt added'); }, 300);
}

function deleteReceipt(): void {
  if (!editingId) return;
  receipts = receipts.filter(r => r.id !== editingId);
  saveReceipts(receipts);
  closeSheet();
  setTimeout(() => { render(); showToast('Receipt deleted'); }, 300);
}

// ── Send report ────────────────────────────────────────────────────────────────

async function sendReport(): Promise<void> {
  if (receipts.length === 0) { showToast('No receipts to send'); return; }

  const overlay = document.getElementById('send-overlay')!;
  const msg     = document.getElementById('send-msg')!;
  overlay.hidden = false;

  try {
    msg.textContent = 'Generating PDF…';
    const pdfDataUri = await generatePDF(trip!, receipts);
    const pdfBase64  = pdfDataUri.split(',')[1];
    const csv        = generateCSV(trip!, receipts);

    // Collect any PDF receipts as separate attachments
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
        to:        trip!.email,
        name:      trip!.name,
        tripName:  trip!.tripName,
        pdfBase64,
        csv,
        pdfAttachments,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }

    overlay.hidden = true;
    showToast('Report sent! Check your inbox.');
  } catch (e) {
    overlay.hidden = true;
    showToast(`Failed: ${(e as Error).message}`);
  }
}

// ── New trip confirmation ──────────────────────────────────────────────────────

function confirmNewTrip(): void {
  const overlay = document.getElementById('confirm-overlay')!;
  overlay.hidden = false;
  document.getElementById('confirm-cancel')!.addEventListener('click', () => { overlay.hidden = true; });
  document.getElementById('confirm-ok')!.addEventListener('click', () => {
    clearTrip();
    trip     = null;
    receipts = [];
    overlay.hidden = true;
    render();
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────────

function showToast(msg: string): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  toast.classList.add('toast--show');
  setTimeout(() => {
    toast.classList.remove('toast--show');
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 2800);
}

// ── Boot ───────────────────────────────────────────────────────────────────────

render();
