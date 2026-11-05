/* Orders console — sends a tracking number to the customer via /api/track */

const $ = (s) => document.querySelector(s);
const tokenEl = $('#token');

try {
  const saved = sessionStorage.getItem('align_admin_token');
  if (saved) tokenEl.value = saved;
} catch {}

$('#trackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#sendBtn');
  const out = $('#result');

  btn.disabled = true;
  btn.textContent = 'Sending…';
  out.innerHTML = '';

  try {
    sessionStorage.setItem('align_admin_token', tokenEl.value);
  } catch {}

  try {
    const res = await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: tokenEl.value,
        sessionId: $('#sessionId').value.trim(),
        tracking: $('#tracking').value.trim(),
        carrier: $('#carrier').value
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      out.innerHTML = `<div class="note-box warn">${data.error || 'Request failed (' + res.status + ').'}</div>`;
      return;
    }

    out.innerHTML = data.emailSent
      ? `<div class="note-box ok">Tracking email sent to <strong>${data.customerEmail}</strong>.</div>`
      : `<div class="note-box warn">Stripe session found for ${data.customerEmail}, but no email service is configured. Copy this and send it yourself:</div>
         <pre>${data.draft || ''}</pre>`;
  } catch {
    out.innerHTML = `<div class="note-box warn">Could not reach the API. Is the worker deployed?</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Notify customer';
  }
});
