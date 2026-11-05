/**
 * ============================================================
 *  ALIGN — Cloudflare Worker (Pages "advanced mode")
 *  ------------------------------------------------------------
 *  Routes:
 *    POST /api/checkout  → creates a Stripe Checkout Session
 *    POST /api/webhook   → Stripe → Discord notification
 *    POST /api/track     → admin: email the customer a tracking link
 *    everything else     → static site in this folder
 *
 *  Prices are NOT duplicated here — they are read from
 *  /data/products.json, the same file the storefront uses.
 *  That means a customer can never invent a price.
 * ============================================================
 */

/* ---------- supplier links (private: never sent to the browser) ---------- */

const SUPPLIERS = {
  'fascia-roller': 'https://www.aliexpress.com/item/1005012889843026.html',
  'posture-corrector': 'https://www.aliexpress.com/item/1005005303102691.html',
  'heel-support': 'https://www.aliexpress.com/item/1005007817702035.html',
  'heat-therapy-brace': 'https://www.aliexpress.com/item/1005012055877325.html'
};

const SHIP_COUNTRIES = [
  'US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'NL', 'BE', 'ES', 'IT', 'PT',
  'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'SK', 'HU', 'RO', 'GR', 'HR',
  'SI', 'BG', 'EE', 'LV', 'LT', 'LU', 'MT', 'CY', 'AE', 'SA', 'QA', 'KW', 'BH',
  'OM', 'IL', 'TR', 'PK', 'IN', 'BD', 'LK', 'NP', 'SG', 'MY', 'TH', 'VN', 'PH',
  'ID', 'JP', 'KR', 'HK', 'TW', 'ZA', 'NG', 'KE', 'EG', 'MA', 'BR', 'MX', 'AR',
  'CL', 'CO', 'PE', 'UY', 'CR'
];

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra
    }
  });

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/* ---------- catalog (single source of truth) ---------- */

async function getCatalog(request, env) {
  const url = new URL('/data/products.json', request.url);
  const res = await env.ASSETS.fetch(new Request(url.toString(), { cf: { cacheTtl: 60 } }));
  if (!res.ok) throw new Error('catalog unavailable');
  return res.json();
}

/* ---------- signature + timing-safe helpers ---------- */

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacHex(secret, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyStripe(rawBody, header, secret) {
  if (!header || !secret) return false;
  let ts = null;
  const v1 = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') ts = v;
    if (k === 'v1') v1.push(v);
  }
  if (!ts || !v1.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5 min tolerance
  const expected = await hmacHex(secret, `${ts}.${rawBody}`);
  return v1.some((sig) => safeEqual(sig, expected));
}

/* ---------- stripe ---------- */

async function stripeRequest(env, path, form) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
  return data;
}

async function stripeGet(env, path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
  return data;
}

/* ============================================================
   POST /api/checkout
   body: { items: [{ id, variant, qty }] }
   ============================================================ */

async function handleCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return json(
      { error: 'Stripe is not connected yet. Add STRIPE_SECRET_KEY in Cloudflare → Settings → Variables.' },
      503
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400);
  }

  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) return json({ error: 'Your bag is empty.' }, 400);
  if (items.length > 20) return json({ error: 'Too many items in one order.' }, 400);

  let catalog;
  try {
    catalog = await getCatalog(request, env);
  } catch {
    return json({ error: 'Catalog unavailable, please try again.' }, 500);
  }

  const form = new URLSearchParams();
  const origin = new URL(request.url).origin;
  const summary = [];
  let subtotal = 0;
  let idx = 0;

  for (const raw of items) {
    const product = catalog.products.find((p) => p.id === raw?.id);
    if (!product) continue;

    const variant = product.variants?.find((v) => v.label === raw.variant) || product.variants?.[0];
    const variantLabel = variant?.label || 'Standard';
    const qty = Math.max(1, Math.min(20, parseInt(raw.qty, 10) || 1));

    // price comes from the catalog, never from the client
    const unit = product.price + (variant?.delta || 0);
    subtotal += unit * qty;

    const base = `line_items[${idx}]`;
    form.append(`${base}[quantity]`, String(qty));
    form.append(`${base}[price_data][currency]`, catalog.currency || 'usd');
    form.append(`${base}[price_data][unit_amount]`, String(unit));
    form.append(`${base}[price_data][product_data][name]`, product.name);
    form.append(`${base}[price_data][product_data][description]`, `${variantLabel} · free shipping`);
    form.append(`${base}[price_data][product_data][metadata][sku]`, `${product.id}:${variantLabel}`);

    summary.push(`${product.id}|${variantLabel}|${qty}|${unit}`);
    idx++;
  }

  if (!idx) return json({ error: 'None of those products exist any more.' }, 400);
  if (subtotal > 500000) return json({ error: 'Order too large — please contact us.' }, 400);

  form.append('mode', 'payment');
  form.append('success_url', `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`);
  form.append('cancel_url', `${origin}/?canceled=1#collection`);
  form.append('customer_creation', 'always');
  form.append('billing_address_collection', 'auto');
  form.append('phone_number_collection[enabled]', 'true');
  form.append('allow_promotion_codes', 'true');
  form.append('submit_type', 'pay');
  form.append('metadata[items]', summary.join(';').slice(0, 490));
  form.append('metadata[channel]', 'align-store');

  SHIP_COUNTRIES.forEach((c, i) => form.append(`shipping_address_collection[allowed_countries][${i}]`, c));

  // free shipping, always
  form.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
  form.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', '0');
  form.append('shipping_options[0][shipping_rate_data][display_name]', 'Free worldwide shipping');
  form.append('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]', '6');
  form.append('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]', 'business_day');
  form.append('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]', '12');
  form.append('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]', 'business_day');

  try {
    const session = await stripeRequest(env, 'checkout/sessions', form);
    return json({ url: session.url, id: session.id });
  } catch (err) {
    return json({ error: err.message || 'Could not start checkout.' }, 502);
  }
}

/* ============================================================
   POST /api/webhook   (Stripe → Discord)
   ============================================================ */

const CARRIER_URL = (carrier, tracking) => {
  const t = encodeURIComponent(tracking);
  const c = (carrier || '').toLowerCase();
  if (c.includes('cainiao') || c.includes('aliexpress'))
    return `https://global.cainiao.com/newDetail.htm?mailNoList=${t}`;
  if (c.includes('yun')) return `https://www.yuntrack.com/parcelTracking?id=${t}`;
  if (c.includes('4px')) return `https://track.4px.com/#/result/0/${t}`;
  if (c.includes('dhl')) return `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${t}`;
  return `https://t.17track.net/en#nums=${t}`;
};

async function handleWebhook(request, env) {
  const raw = await request.text();
  const sig = request.headers.get('stripe-signature');
  const secret = env.STRIPE_WEBHOOK_SECRET;

  if (secret) {
    const ok = await verifyStripe(raw, sig, secret);
    if (!ok) return json({ error: 'Invalid signature.' }, 400);
  } else if (env.STRIPE_SECRET_KEY) {
    return json({ error: 'STRIPE_WEBHOOK_SECRET is not set.' }, 503);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'Bad payload.' }, 400);
  }

  const relevant = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!relevant.includes(event.type)) return json({ received: true, ignored: event.type });

  const s = event.data?.object || {};
  if (s.payment_status && s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') {
    return json({ received: true, pending: s.payment_status });
  }

  // shipping details moved under collected_information in recent API versions
  const ship = s.collected_information?.shipping_details || s.shipping_details || null;
  const addr = ship?.address || s.customer_details?.address || {};
  const customer = s.customer_details || {};

  // rebuild the basket from our own metadata
  let lines = [];
  try {
    let catalog = null;
    try {
      catalog = await getCatalog(request, env);
    } catch {
      /* names can fall back to the id */
    }
    lines = String(s.metadata?.items || '')
      .split(';')
      .filter(Boolean)
      .map((chunk) => {
        const [id, variant, qty, unit] = chunk.split('|');
        const p = catalog?.products?.find((x) => x.id === id);
        return {
          id,
          variant,
          qty: Number(qty) || 1,
          unit: Number(unit) || 0,
          name: p?.name || id,
          supplier: SUPPLIERS[id] || null
        };
      });
  } catch {
    lines = [];
  }

  const itemText = lines.length
    ? lines.map((l) => `• **${l.name}** — ${l.variant} × ${l.qty}`).join('\n').slice(0, 1000)
    : '• (see Stripe dashboard)';

  const supplierText = lines
    .filter((l) => l.supplier)
    .map((l) => `[${l.name}](${l.supplier})`)
    .join(' · ')
    .slice(0, 1000);

  const addressText = [
    ship?.name || customer.name || '(no name)',
    addr.line1,
    addr.line2,
    [addr.city, addr.state, addr.postal_code].filter(Boolean).join(', '),
    addr.country
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000);

  const total = s.amount_total ?? 0;

  const embed = {
    title: `🛒 New order — ${money(total)}`,
    color: 0x1d8a5b,
    description: `**${customer.name || 'Customer'}** just paid. Order it now.`,
    fields: [
      { name: 'Contact', value: `[${customer.email || 'no email'}](mailto:${customer.email || ''})\n${customer.phone || 'no phone'}`, inline: true },
      { name: 'Ship to', value: addressText || '(no address)', inline: true },
      { name: 'Items', value: itemText, inline: false },
      { name: 'Supplier links', value: supplierText || '(none)', inline: false },
      { name: 'Stripe session', value: '`' + (s.id || '—') + '`', inline: false }
    ],
    footer: { text: `ALIGN · ${s.payment_status || 'paid'} · copy the session ID into /admin.html when it ships` },
    timestamp: new Date().toISOString()
  };

  const hook = env.DISCORD_WEBHOOK_URL;
  if (hook) {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ALIGN orders', embeds: [embed] })
    });
    if (!res.ok) return json({ received: true, discord: `failed ${res.status}` }, 200);
  }

  return json({ received: true });
}

/* ============================================================
   POST /api/track   (admin → customer email + Discord)
   body: { token, sessionId, tracking, carrier }
   ============================================================ */

async function handleTrack(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN is not set.' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400);
  }

  if (!safeEqual(String(body?.token || ''), env.ADMIN_TOKEN)) {
    return json({ error: 'Wrong token.' }, 401);
  }

  const sessionId = String(body.sessionId || '').trim();
  const tracking = String(body.tracking || '').trim().slice(0, 60);
  const carrier = String(body.carrier || 'Other').slice(0, 60);

  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json({ error: 'That is not a Stripe session ID (cs_…).' }, 400);
  if (tracking.length < 4) return json({ error: 'Tracking number looks too short.' }, 400);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'STRIPE_SECRET_KEY missing.' }, 503);

  let session;
  try {
    session = await stripeGet(env, `checkout/sessions/${sessionId}`);
  } catch (err) {
    return json({ error: `Stripe: ${err.message}` }, 404);
  }

  const email = session.customer_details?.email || session.customer_email;
  if (!email) return json({ error: 'That session has no customer email.' }, 422);

  const name = session.customer_details?.name || 'there';
  const url = CARRIER_URL(carrier, tracking);
  const items = String(session.metadata?.items || '')
    .split(';')
    .filter(Boolean)
    .map((c) => c.split('|')[0]);

  const subject = 'Your ALIGN order is on its way';
  const text =
`Hi ${name},

Good news — your order has shipped.

Carrier:  ${carrier}
Tracking: ${tracking}
Track it: ${url}

Most parcels arrive within 6–12 business days of dispatch. If anything looks wrong, just reply to this email.

— ALIGN
Recovery, engineered.`;

  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0b0b0c">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px">
    <div style="font-size:13px;letter-spacing:.22em;font-weight:600;margin-bottom:28px">ALIGN</div>
    <div style="background:#fff;border-radius:18px;padding:32px">
      <h1 style="font-size:24px;letter-spacing:-.03em;margin:0 0 12px">Your order has shipped.</h1>
      <p style="margin:0 0 24px;color:#6e6e73;font-size:15px;line-height:1.6">Hi ${name}, your parcel left the warehouse. Here is everything you need to follow it.</p>
      <table style="width:100%;font-size:14px;border-collapse:collapse;margin-bottom:24px">
        <tr><td style="padding:8px 0;color:#6e6e73;width:38%">Carrier</td><td style="padding:8px 0">${carrier}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;border-top:1px solid #e2e2e6">Tracking</td><td style="padding:8px 0;border-top:1px solid #e2e2e6;font-family:ui-monospace,monospace">${tracking}</td></tr>
      </table>
      <a href="${url}" style="display:block;background:#0071e3;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:999px;font-size:15px;font-weight:500">Track my parcel</a>
      <p style="margin:24px 0 0;color:#6e6e6e;font-size:13px;line-height:1.6">Usually 6–12 business days from dispatch. Tracking can take 24–48 hours to show its first scan.</p>
    </div>
    <p style="color:#86868b;font-size:12px;line-height:1.6;margin-top:24px">Questions? Reply to this email. 30-day returns, no questions asked.</p>
  </div></body></html>`;

  let emailSent = false;
  let emailError = null;

  if (env.RESEND_API_KEY) {
    const from = env.EMAIL_FROM || 'ALIGN <orders@example.com>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from, to: [email], subject, text, html })
    });
    if (res.ok) emailSent = true;
    else emailError = `Email service returned ${res.status}`;
  }

  if (env.DISCORD_WEBHOOK_URL) {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'ALIGN orders',
        embeds: [
          {
            title: '📦 Marked as shipped',
            color: 0x0071e3,
            fields: [
              { name: 'Customer', value: email, inline: true },
              { name: 'Carrier', value: carrier, inline: true },
              { name: 'Tracking', value: '`' + tracking + '`', inline: true },
              { name: 'Items', value: items.join(', ') || '—', inline: false },
              { name: 'Session', value: '`' + sessionId + '`', inline: false }
            ],
            timestamp: new Date().toISOString()
          }
        ]
      })
    }).catch(() => {});
  }

  return json({
    ok: true,
    customerEmail: email,
    emailSent,
    emailError,
    trackingUrl: url,
    draft: emailSent ? null : `To: ${email}\nSubject: ${subject}\n\n${text}`
  });
}

/* ============================================================
   router
   ============================================================ */

const CORS = (request) => {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin'
  };
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS(request) });

      try {
        let res;
        if (path === '/api/checkout') {
          if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
          res = await handleCheckout(request, env);
        } else if (path === '/api/webhook') {
          if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
          res = await handleWebhook(request, env);
        } else if (path === '/api/track') {
          if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
          res = await handleTrack(request, env);
        } else if (path === '/api/health') {
          // no secrets here — just tells you what is wired up
          return json({
            ok: true,
            stripe: Boolean(env.STRIPE_SECRET_KEY),
            webhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET),
            discord: Boolean(env.DISCORD_WEBHOOK_URL),
            admin: Boolean(env.ADMIN_TOKEN),
            email: Boolean(env.RESEND_API_KEY),
            catalog: await getCatalog(request, env)
              .then((c) => c.products.length + ' products')
              .catch(() => 'unavailable')
          });
        } else {
          return json({ error: 'No such endpoint.' }, 404);
        }

        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS(request))) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      } catch (err) {
        return json({ error: err?.message || 'Unexpected error.' }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
