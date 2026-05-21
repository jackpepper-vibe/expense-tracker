export const config = { runtime: 'edge' };

const CATEGORIES = [
  'Air Fares', 'Hotel/Lodging', 'Working Meals', 'Taxis/Transport',
  'Client Entertainment', 'Marketing/Client Travel', 'PM Travel/Sales', 'Other',
];

const PROMPT = `Analyse this receipt and extract key fields. Return ONLY a JSON object — no markdown, no explanation:
{
  "date": "YYYY-MM-DD",
  "amount": 0.00,
  "location": "",
  "nature": "",
  "category": ""
}

Rules:
- date: the transaction date in YYYY-MM-DD format. If only day/month visible, assume current year. Null if truly not visible.
- amount: the final total charged (after tax/tip). Numeric only, no currency symbol. Null if not visible.
- location: merchant name and/or city, concise (e.g. "Café de Flore, Paris" or "Air France"). Null if not visible.
- nature: brief description of what was purchased (e.g. "Dinner for 2 with client", "Taxi to airport", "Economy flight Dublin–Paris"). 1 short sentence.
- category: pick the single best match from: ${CATEGORIES.join(', ')}.`;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body: { imageBase64?: string; mediaType?: string; pdfBase64?: string };
  try {
    body = await req.json();
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

    const data = JSON.parse(match[0]);
    return new Response(JSON.stringify(data), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
