import { resolveReceiptDate } from './_lib/receipt-date';

export const config = { runtime: 'edge' };

const CATEGORIES = [
  'Air Fares', 'Hotel/Lodging', 'Working Meals', 'Taxis/Transport',
  'Client Entertainment', 'Marketing/Client Travel', 'PM Travel/Sales', 'Other',
];

const PROMPT = `Analyse this receipt and extract key fields. Return ONLY a JSON object — no markdown, no explanation:
{
  "date_raw": "",
  "weekday": "",
  "country": "",
  "amount": 0.00,
  "location": "",
  "nature": "",
  "category": ""
}

Rules:
- date_raw: the transaction date copied EXACTLY as printed, character for character (e.g. "07-10-2026", "10/07/26", "7 oct. 2026"). Do NOT reorder, reformat or interpret it. Exclude the time and weekday. Null if not visible.
- weekday: the day of the week if printed anywhere on the receipt (e.g. "Wednesday", "mer."), exactly as printed. Null if not printed.
- country: ISO 3166-1 alpha-2 code of the country where the merchant is located (e.g. "IE", "FR", "US"), inferred from address, phone, currency or language. Null if unclear.
- amount: the final total charged (after tax/tip). Numeric only, no currency symbol. Null if not visible.
- location: merchant name and/or city, concise (e.g. "Café de Flore, Paris" or "Air France"). Null if not visible.
- nature: brief description of what was purchased (e.g. "Dinner for 2 with client", "Taxi to airport", "Economy flight Dublin–Paris"). 1 short sentence.
- category: pick the single best match from: ${CATEGORIES.join(', ')}.`;

/** Raw shape returned by the model. */
interface ModelReceipt {
  date_raw?: string | null;
  weekday?:  string | null;
  country?:  string | null;
  amount?:   number | null;
  location?: string | null;
  nature?:   string | null;
  category?: string | null;
}

/** Response contract consumed by the client. */
interface ReceiptAnalysis {
  date:     string | null;
  amount:   number | null;
  location: string | null;
  nature:   string | null;
  category: string | null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body: { imageBase64?: string; mediaType?: string; pdfBase64?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { imageBase64, mediaType, pdfBase64 } = body;
  if (!imageBase64 && !pdfBase64) {
    return new Response(JSON.stringify({ error: 'Missing image or PDF data' }), { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500 });
  }

  const fileBlock = pdfBase64
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType ?? 'image/jpeg', data: imageBase64! } };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 256,
        messages:   [{ role: 'user', content: [fileBlock, { type: 'text', text: PROMPT }] }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: `Anthropic API error: ${res.status}`, detail: err }), { status: 502 });
    }

    const result = await res.json() as { content: { type: string; text: string }[] };
    const text   = result.content?.[0]?.text?.trim() ?? '';
    const match  = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');

    const parsed = JSON.parse(match[0]) as ModelReceipt;
    const data: ReceiptAnalysis = {
      date:     resolveReceiptDate(parsed.date_raw, { weekday: parsed.weekday, country: parsed.country }),
      amount:   parsed.amount ?? null,
      location: parsed.location ?? null,
      nature:   parsed.nature ?? null,
      category: parsed.category ?? null,
    };
    return new Response(JSON.stringify(data), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
