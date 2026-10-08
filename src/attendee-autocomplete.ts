// Type-ahead for the comma-separated Attendees field.
//
// Suggests names from the attendee history for the name currently being typed
// (the text between the commas around the caret). Picking one completes it and
// adds a separator so the next name can be typed straight away. Each suggestion
// has a small × to stop suggesting that person.

import { AttendeeDirectory, parseAttendees, nameKey, type AttendeeEntry } from './attendees.ts';

export interface AutocompleteOptions {
  /** Called after a name is removed from suggestions. */
  onForget?: (name: string) => void;
}

interface Token { start: number; end: number; text: string; }

let instanceSeq = 0;

export class AttendeeAutocomplete {
  private readonly list: HTMLUListElement;
  private readonly listId = `attendee-suggestions-${++instanceSeq}`;
  private items: AttendeeEntry[] = [];
  private active = -1;

  constructor(
    private readonly input: HTMLInputElement,
    private readonly directory: AttendeeDirectory,
    private readonly options: AutocompleteOptions = {},
  ) {
    this.list = document.createElement('ul');
    this.list.className = 'ac-list';
    this.list.id = this.listId;
    this.list.setAttribute('role', 'listbox');
    this.list.hidden = true;
    input.insertAdjacentElement('afterend', this.list);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', this.listId);
    input.setAttribute('aria-expanded', 'false');

    input.addEventListener('input',   () => this.refresh());
    input.addEventListener('click',   () => this.refresh());
    input.addEventListener('keydown', e => this.onKeyDown(e));
    input.addEventListener('blur',    () => setTimeout(() => {
      if (document.activeElement !== this.input) this.close();
    }, 120));

    // Keep focus (and the on-screen keyboard) in the input while tapping the list.
    const keepFocus = (e: Event) => e.preventDefault();
    this.list.addEventListener('pointerdown', keepFocus);
    this.list.addEventListener('mousedown', keepFocus);
    this.list.addEventListener('click', e => this.onListClick(e));
  }

  // ── Token under the caret ───────────────────────────────────────────────────

  private currentToken(): Token {
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    const start = value.lastIndexOf(',', caret - 1) + 1;
    const next  = value.indexOf(',', caret);
    const end   = next === -1 ? value.length : next;
    return { start, end, text: value.slice(start, end).trim() };
  }

  /** Names already in the field other than the one being typed. */
  private otherNames(token: Token): string[] {
    const value = this.input.value;
    return parseAttendees(value.slice(0, token.start) + ',' + value.slice(token.end));
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  private refresh(): void {
    const token = this.currentToken();
    this.items  = token.text ? this.directory.suggest(token.text, this.otherNames(token)) : [];
    // Nothing to offer if the only match is exactly what's already typed.
    if (this.items.length === 1 && nameKey(this.items[0].name) === nameKey(token.text)) this.items = [];
    this.active = this.items.length > 0 ? 0 : -1;
    this.render(token.text);
  }

  private render(query: string): void {
    if (this.items.length === 0) { this.close(); return; }
    this.list.innerHTML = this.items.map((entry, i) => `
      <li class="ac-item${i === this.active ? ' ac-item--active' : ''}" role="option" id="${this.listId}-${i}"
          aria-selected="${i === this.active}" data-index="${i}">
        <span class="ac-name">${highlight(entry.name, query)}</span>
        <button type="button" class="ac-forget" data-forget="${i}" tabindex="-1"
                aria-label="Stop suggesting ${escapeHtml(entry.name)}" title="Stop suggesting">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
      </li>`).join('');
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.updateActiveDescendant();
  }

  private close(): void {
    this.list.hidden = true;
    this.items = [];
    this.active = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  private updateActiveDescendant(): void {
    if (this.active >= 0) this.input.setAttribute('aria-activedescendant', `${this.listId}-${this.active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private moveActive(delta: number): void {
    if (this.items.length === 0) return;
    this.active = (this.active + delta + this.items.length) % this.items.length;
    this.list.querySelectorAll('.ac-item').forEach((el, i) => {
      el.classList.toggle('ac-item--active', i === this.active);
      el.setAttribute('aria-selected', String(i === this.active));
    });
    this.updateActiveDescendant();
  }

  // ── Interaction ─────────────────────────────────────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (this.list.hidden) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); this.moveActive(1);  break;
      case 'ArrowUp':   e.preventDefault(); this.moveActive(-1); break;
      case 'Enter':
      case 'Tab':
        if (this.active >= 0) { e.preventDefault(); this.select(this.items[this.active]); }
        break;
      case 'Escape': e.preventDefault(); this.close(); break;
    }
  }

  private onListClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const forget = target.closest<HTMLElement>('[data-forget]');
    if (forget) {
      const entry = this.items[Number(forget.dataset['forget'])];
      if (!entry) return;
      this.directory.forget(entry.name);
      this.options.onForget?.(entry.name);
      this.refresh();
      this.input.focus();
      return;
    }
    const item = target.closest<HTMLElement>('[data-index]');
    const entry = item ? this.items[Number(item.dataset['index'])] : undefined;
    if (entry) this.select(entry);
  }

  /** Replaces the name being typed with `entry` and readies the field for the next one. */
  private select(entry: AttendeeEntry): void {
    const token  = this.currentToken();
    const value  = this.input.value;
    const before = value.slice(0, token.start).replace(/\s*$/, '');
    const after  = value.slice(token.end).replace(/^,?\s*/, '');
    const head   = before ? `${before} ${entry.name}` : entry.name;
    const next   = after ? `${head}, ${after}` : `${head}, `;
    this.input.value = next;
    const caret = head.length + 2;
    this.input.setSelectionRange(caret, caret);
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    this.close();
    this.input.focus();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Bolds the part of `name` that matches `query` (accent/case-insensitive). */
function highlight(name: string, query: string): string {
  const q = nameKey(query);
  const folded = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // Folding can change length (e.g. ligatures); only highlight when it doesn't.
  if (!q || folded.length !== name.length) return escapeHtml(name);
  let at = folded.startsWith(q) ? 0 : -1;
  for (let i = 1; at === -1 && i < folded.length; i++) {
    if (!/[a-z0-9]/.test(folded[i - 1]) && folded.startsWith(q, i)) at = i;
  }
  if (at === -1) return escapeHtml(name);
  return `${escapeHtml(name.slice(0, at))}<strong>${escapeHtml(name.slice(at, at + q.length))}</strong>${escapeHtml(name.slice(at + q.length))}`;
}
