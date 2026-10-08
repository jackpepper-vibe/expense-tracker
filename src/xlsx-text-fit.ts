// Fits free text into a fixed-size spreadsheet cell by wrapping it and, when
// needed, stepping the font down — without changing column width or row height.
//
// Excel can't combine wrap-text with shrink-to-fit, so the size decision is made
// here: each candidate size gets its own cell style (cloned from the template's
// style, with wrapping on), and the largest size whose word-wrapped text fits
// the cell's line budget is chosen per cell.

/** Geometry of the target cell, in Excel units. */
export interface CellBox {
  /** Column width in characters (the <col width> value). */
  widthChars: number;
  /** Row height in points. */
  heightPt:   number;
}

/** Font sizes tried, largest first. The first is the template's own size. */
export const FIT_FONT_SIZES = [10, 9, 8, 7, 6] as const;
export type FitFontSize = typeof FIT_FONT_SIZES[number];

// ── Font metrics ──────────────────────────────────────────────────────────────
// The template font (MS Sans Serif, rendered by Excel as Microsoft Sans Serif)
// shares Arial's advance widths. Widths are in 1/1000 em.
//
// Calibrated against Excel's own rendering of the expense form: measured this
// way, every line Excel kept on one line was ≤ 1.034 of the column width and
// every line it wrapped was ≥ 1.039, across both columns and sizes 7–10pt.

const CHAR_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  '[': 278, ']': 278, '_': 556, '|': 260, '€': 556, '£': 556,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
};
const DIGIT_WIDTH   = 556;
const DEFAULT_WIDTH = 600;   // unlisted characters — errs wide

/** Pixel width of one column-width unit: the workbook default font's max digit width. */
const COLUMN_UNIT_PX = 7;
/** Fraction of the column width a line may fill (calibrated limit is ~1.03). */
const LINE_FILL      = 1.0;
/** Excel line height as a multiple of font size. */
const LINE_HEIGHT    = 1.2;
/** Points lost to cell top/bottom padding. */
const CELL_PADDING   = 2;

function columnWidthPt(box: CellBox): number {
  return Math.round(box.widthChars * COLUMN_UNIT_PX) * 0.75;
}

function textWidthPt(text: string, size: number): number {
  let em = 0;
  for (const ch of text.normalize('NFD').replace(/[̀-ͯ]/g, '')) {
    em += CHAR_WIDTHS[ch] ?? (ch >= '0' && ch <= '9' ? DIGIT_WIDTH : DEFAULT_WIDTH);
  }
  return (em / 1000) * size;
}

function maxLines(box: CellBox, size: number): number {
  return Math.max(1, Math.floor((box.heightPt - CELL_PADDING) / (size * LINE_HEIGHT)));
}

/**
 * Lines Excel's word wrap produces: breaks after spaces and hyphens, and
 * splits a single segment wider than the line character by character.
 */
function wrappedLineCount(text: string, size: number, lineWidthPt: number): number {
  const segments = text.trim().split(/(?<=[\s-])/).filter(Boolean);
  let lines = 1, line = '';
  for (const seg of segments) {
    const candidate = line + seg;
    if (textWidthPt(candidate.trimEnd(), size) <= lineWidthPt) { line = candidate; continue; }
    if (line) { lines++; line = ''; }
    for (const ch of seg) {
      if (line && textWidthPt((line + ch).trimEnd(), size) > lineWidthPt) { lines++; line = ''; }
      line += ch;
    }
  }
  return lines;
}

/** Largest font size at which the text fits the cell; the smallest size if none does. */
export function fitFontSize(text: string, box: CellBox): FitFontSize {
  const lineWidthPt = columnWidthPt(box) * LINE_FILL;
  for (const size of FIT_FONT_SIZES) {
    if (wrappedLineCount(text, size, lineWidthPt) <= maxLines(box, size)) return size;
  }
  return FIT_FONT_SIZES[FIT_FONT_SIZES.length - 1];
}

/** Cell style index for each fit size, derived from one template style. */
export type FitStyleSet = Record<FitFontSize, number>;

/**
 * Registers wrap-text variants of `baseXf` (a cellXfs index) at every fit size
 * in styles.xml. Returns the updated XML and the style index for each size.
 */
export function registerFitStyles(stylesXml: string, baseXf: number): { xml: string; styles: FitStyleSet } {
  const fontsMatch = stylesXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/);
  const xfsMatch   = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!fontsMatch || !xfsMatch) throw new Error('styles.xml: missing fonts or cellXfs');

  const fonts = fontsMatch[1].match(/<font\b[^>]*\/>|<font\b[^>]*>[\s\S]*?<\/font>/g) ?? [];
  const xfs   = xfsMatch[1].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) ?? [];
  const base  = xfs[baseXf];
  if (!base) throw new Error(`styles.xml: no cellXfs entry ${baseXf}`);

  const baseFontId = Number(base.match(/\bfontId="(\d+)"/)?.[1] ?? 0);
  const baseFont   = fonts[baseFontId];
  if (!baseFont) throw new Error(`styles.xml: no font ${baseFontId}`);

  const newFonts: string[] = [];
  const newXfs:   string[] = [];
  const styles = {} as FitStyleSet;

  for (const size of FIT_FONT_SIZES) {
    const fontId = fonts.length + newFonts.length;
    newFonts.push(/<sz\b/.test(baseFont)
      ? baseFont.replace(/<sz val="[^"]*"\/>/, `<sz val="${size}"/>`)
      : baseFont.replace(/<font\b[^>]*>/, m => `${m}<sz val="${size}"/>`));
    styles[size] = xfs.length + newXfs.length;
    newXfs.push(withWrapAlignment(base.replace(/\bfontId="\d+"/, `fontId="${fontId}"`)));
  }

  const xml = stylesXml
    .replace(fontsMatch[0], rebuild(fontsMatch[0], 'fonts', [...fonts, ...newFonts]))
    .replace(xfsMatch[0],   rebuild(xfsMatch[0], 'cellXfs', [...xfs, ...newXfs]));
  return { xml, styles };
}

function withWrapAlignment(xf: string): string {
  // Vertical alignment stays the template default (bottom) to line up with the row's other cells.
  const alignment = '<alignment wrapText="1"/>';
  const open = xf.match(/^<xf\b[^>]*?(\/?)>/)!;
  let tag = open[0].replace(/\s*\/?>$/, '');
  tag = /\bapplyAlignment=/.test(tag) ? tag.replace(/\bapplyAlignment="\d"/, 'applyAlignment="1"') : `${tag} applyAlignment="1"`;
  if (open[1] === '/') return `${tag}>${alignment}</xf>`;
  const inner = xf.slice(open[0].length, -'</xf>'.length).replace(/<alignment\b[^>]*\/>/, '');
  // <alignment> must precede <protection> per the OOXML schema.
  return `${tag}>${alignment}${inner}</xf>`;
}

function rebuild(block: string, tagName: string, items: string[]): string {
  const open = block.match(new RegExp(`^<${tagName}\\b[^>]*>`))![0]
    .replace(/\bcount="\d+"/, `count="${items.length}"`);
  return `${open}${items.join('')}</${tagName}>`;
}
