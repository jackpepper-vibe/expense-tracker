// Deterministic resolution of receipt dates.
//
// The vision model transcribes the date exactly as printed; this module decides
// what it means. Numeric dates such as "07-10-2026" are ambiguous (7 Oct vs 10 Jul),
// and leaving that call to the model produced intermittent US-order misreads on
// European receipts. Resolution order for ambiguous dates:
//   1. a printed weekday that matches exactly one reading
//   2. discard readings in the future (receipts are never post-dated)
//   3. the merchant country's convention (month-first only for MDY countries)
//   4. day-first, the convention for every market this app is used in

export interface DateContext {
  /** Weekday printed on the receipt, any language/abbreviation, if present. */
  weekday?: string | null;
  /** ISO 3166-1 alpha-2 country of the merchant, if known. */
  country?: string | null;
  /** Reference "today" (UTC). Defaults to now. */
  today?: Date;
}

interface Ymd { y: number; m: number; d: number; }

/** Countries that conventionally print numeric dates month-first. */
const MONTH_FIRST_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'PH', 'FM', 'MH', 'PW']);

/** Tolerance for "future" dates — covers timezone differences around midnight. */
const FUTURE_TOLERANCE_DAYS = 1;

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, janvier: 1, janv: 1, enero: 1, januar: 1, gennaio: 1, ene: 1, gen: 1,
  feb: 2, february: 2, fevrier: 2, fevr: 2, fev: 2, febrero: 2, februar: 2, febbraio: 2,
  mar: 3, march: 3, mars: 3, marzo: 3, marz: 3, maerz: 3,
  apr: 4, april: 4, avril: 4, avr: 4, abril: 4, abr: 4, aprile: 4,
  may: 5, mai: 5, mayo: 5, maggio: 5, mag: 5,
  jun: 6, june: 6, juin: 6, junio: 6, juni: 6, giugno: 6, giu: 6,
  jul: 7, july: 7, juillet: 7, juil: 7, julio: 7, juli: 7, luglio: 7, lug: 7,
  aug: 8, august: 8, aout: 8, agosto: 8, ago: 8,
  sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9, settembre: 9, set: 9,
  oct: 10, october: 10, octobre: 10, octubre: 10, oktober: 10, ottobre: 10, okt: 10, ott: 10,
  nov: 11, november: 11, novembre: 11, noviembre: 11,
  dec: 12, december: 12, decembre: 12, diciembre: 12, dezember: 12, dicembre: 12, dez: 12, dic: 12,
};

/** Weekday prefixes → JS getUTCDay() index. English, French, Spanish, German, Italian. */
const WEEKDAY_PREFIXES: [string, number][] = [
  ['sun', 0], ['dim', 0], ['dom', 0], ['son', 0],
  ['mon', 1], ['lun', 1],
  ['tue', 2], ['mar', 2], ['die', 2],
  ['wed', 3], ['mer', 3], ['mie', 3], ['mit', 3],
  ['thu', 4], ['jeu', 4], ['jue', 4], ['don', 4], ['gio', 4],
  ['fri', 5], ['ven', 5], ['vie', 5], ['fre', 5],
  ['sat', 6], ['sam', 6], ['sab', 6],
];

function normalise(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function parseWeekday(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const w = normalise(raw);
  // "mar" is Tuesday in FR/ES/IT; English "Mar" never appears as a weekday.
  const hit = WEEKDAY_PREFIXES.find(([p]) => w.startsWith(p));
  return hit ? hit[1] : null;
}

function expandYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function isValid({ y, m, d }: Ymd): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toUtc({ y, m, d }: Ymd): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso({ y, m, d }: Ymd): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Every valid reading of the raw string, in day-first-then-month-first order. */
function candidates(raw: string, today: Date): Ymd[] {
  const s = normalise(raw);

  // Year-first: 2026-10-07, 2026/10/07 — unambiguous in practice.
  const ymd = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (ymd) return [{ y: +ymd[1], m: +ymd[2], d: +ymd[3] }].filter(isValid);

  // Numeric a-b-c or a-b (any of - / . space as separators). Checked before
  // month names so a stray weekday abbreviation ("mar") can't read as March.
  const num = s.match(/\b(\d{1,2})[-/. ](\d{1,2})(?:[-/. ](\d{2,4}))?\b/);
  if (num) {
    const a = +num[1], b = +num[2];
    const y = num[3] ? expandYear(+num[3]) : today.getUTCFullYear();
    const dayFirst   = { y, m: b, d: a };
    const monthFirst = { y, m: a, d: b };
    if (a === b) return [dayFirst].filter(isValid);
    return [dayFirst, monthFirst].filter(isValid);
  }

  // Named month: "7 Oct 2026", "Oct 7, 2026", "7 octobre", "7-oct-26".
  const named = s.match(/([a-z]{3,})/g)?.map(w => MONTH_NAMES[w]).find(Boolean);
  if (named) {
    const nums = (s.match(/\d+/g) ?? []).map(Number);
    const day  = nums.find(n => n >= 1 && n <= 31);
    const year = nums.find(n => n !== day && (n >= 1900 || (n >= 0 && n < 100 && nums.length > 1)));
    if (day !== undefined) {
      return [{ y: year !== undefined ? expandYear(year) : today.getUTCFullYear(), m: named, d: day }].filter(isValid);
    }
  }

  return [];
}

/**
 * Resolve a receipt date as printed into ISO YYYY-MM-DD.
 * Returns null when the text contains no recognisable date.
 */
export function resolveReceiptDate(raw: string | null | undefined, ctx: DateContext = {}): string | null {
  if (!raw) return null;
  const today = ctx.today ?? new Date();
  let pool = candidates(raw, today);
  if (pool.length <= 1) return pool[0] ? toIso(pool[0]) : null;

  const weekday = parseWeekday(ctx.weekday);
  if (weekday !== null) {
    const matching = pool.filter(c => toUtc(c).getUTCDay() === weekday);
    if (matching.length >= 1) pool = matching;
  }

  const limit = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + FUTURE_TOLERANCE_DAYS);
  const notFuture = pool.filter(c => toUtc(c).getTime() <= limit);
  if (notFuture.length >= 1) pool = notFuture;

  if (pool.length > 1 && ctx.country && MONTH_FIRST_COUNTRIES.has(ctx.country.toUpperCase())) {
    return toIso(pool[pool.length - 1]);
  }
  return toIso(pool[0]);
}
