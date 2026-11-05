/* ============================================================
   ALIGN — storefront logic
   Shared by every page. No framework, no build step.
   ============================================================ */

const CART_KEY = 'align_cart_v1';
const ICON = {
  bag: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 6h10l1 11H4L5 6Z" stroke-linejoin="round"/><path d="M7.5 6V4.5a2.5 2.5 0 0 1 5 0V6"/></svg>',
  arrow: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1 6h9M6.5 2.5 10 6l-3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 4 12 12M16 4 4 16" stroke-linecap="round"/></svg>',
  tick: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 10.5 4 4 8-9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="8.5" width="12" height="8.5" rx="2"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 7h11v9H2zM13 10h5l3 3v3h-8z" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3l7 3v6c0 4.5-3 7.4-7 9-4-1.6-7-4.5-7-9V6l7-3Z" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke-linecap="round"/></svg>',
  box: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 2.5 17 6v8l-7 3.5L3 14V6l7-3.5Z" stroke-linejoin="round"/><path d="M3 6l7 3.5L17 6M10 9.5v8"/></svg>'
};

/* ---------------- utilities ---------------- */

const money = (cents) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2
  }).format(cents / 100);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
}

/* ---------------- catalog ---------------- */

let CATALOG = null;

async function loadCatalog() {
  if (CATALOG) return CATALOG;
  const res = await fetch('/data/products.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Catalog unavailable');
  CATALOG = await res.json();
  return CATALOG;
}

const findProduct = (id) => (CATALOG ? CATALOG.products.find((p) => p.id === id) : null);

/* ---------------- cart state ---------------- */

function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((l) => l && l.id && l.qty > 0) : [];
  } catch {
    return [];
  }
}

function writeCart(lines) {
  localStorage.setItem(CART_KEY, JSON.stringify(lines));
  document.dispatchEvent(new CustomEvent('cart:change'));
}

function addToCart(id, variant, qty = 1) {
  const lines = readCart();
  const key = `${id}::${variant}`;
  const hit = lines.find((l) => l.id === id && l.variant === variant);
  if (hit) hit.qty = Math.min(hit.qty + qty, 20);
  else lines.push({ id, variant, qty });
  writeCart(lines);
}

function setQty(id, variant, qty) {
  let lines = readCart();
  if (qty <= 0) lines = lines.filter((l) => !(l.id === id && l.variant === variant));
  else {
    const hit = lines.find((l) => l.id === id && l.variant === variant);
    if (hit) hit.qty = Math.min(qty, 20);
  }
  writeCart(lines);
}

const unitPrice = (product, variantLabel) => {
  const v = (product.variants || []).find((x) => x.label === variantLabel);
  return product.price + (v ? v.delta || 0 : 0);
};

function cartDetail() {
  return readCart()
    .map((line) => {
      const product = findProduct(line.id);
      if (!product) return null;
      return { ...line, product, unit: unitPrice(product, line.variant) };
    })
    .filter(Boolean);
}

const cartCount = () => readCart().reduce((n, l) => n + l.qty, 0);
const cartSubtotal = () => cartDetail().reduce((n, l) => n + l.unit * l.qty, 0);

/* ---------------- cart drawer ---------------- */

function mountChrome() {
  if ($('#cartDrawer')) return;
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="scrim" id="scrim" aria-hidden="true"></div>
     <aside class="drawer" id="cartDrawer" aria-label="Shopping bag" aria-hidden="true">
       <div class="drawer-head">
         <h3>Your bag</h3>
         <button class="drawer-close" id="drawerClose" aria-label="Close bag">${ICON.close}</button>
       </div>
       <div class="drawer-body" id="drawerBody"></div>
       <div class="drawer-foot" id="drawerFoot" hidden>
         <div class="line-total"><span>Subtotal</span><span id="subtotal">$0</span></div>
         <div class="line-total tax"><span>Shipping</span><span>Free</span></div>
         <button class="btn btn-primary btn-block" id="checkoutBtn">Checkout</button>
         <div class="secure-note">${ICON.lock} Secure payment by Stripe</div>
       </div>
     </aside>
     <div class="toast" id="toast" role="status" aria-live="polite"></div>`
  );

  $('#scrim').addEventListener('click', closeDrawer);
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#checkoutBtn').addEventListener('click', checkout);

  // cart badge in nav
  const badge = $('#cartCount');
  if (badge) {
    const paint = () => {
      const n = cartCount();
      badge.textContent = n;
      badge.classList.toggle('on', n > 0);
    };
    paint();
    document.addEventListener('cart:change', paint);
  }

  $$('[data-open-cart]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      openDrawer();
    })
  );
}

function renderDrawer() {
  const body = $('#drawerBody');
  const foot = $('#drawerFoot');
  if (!body) return;
  const lines = cartDetail();

  if (!lines.length) {
    body.innerHTML = `<div class="empty">${ICON.bag}<p>Your bag is empty.</p>
      <a class="link-arrow" href="/index.html#collection">Browse the collection ${ICON.arrow}</a></div>`;
    foot.hidden = true;
    return;
  }

  body.innerHTML = lines
    .map(
      (l) => `<div class="ci">
        <div class="ci-img"><img src="${l.product.image}" alt="${l.product.name}" loading="lazy"></div>
        <div>
          <div class="ci-name">${l.product.name}</div>
          <div class="ci-var">${l.variant}</div>
          <div class="ci-qty">
            <button data-dec="${l.id}|${l.variant}" aria-label="Decrease quantity">−</button>
            <span>${l.qty}</span>
            <button data-inc="${l.id}|${l.variant}" aria-label="Increase quantity">+</button>
          </div>
        </div>
        <div class="ci-right">
          <div>${money(l.unit * l.qty)}</div>
          <button class="ci-remove" data-rm="${l.id}|${l.variant}">Remove</button>
        </div>
      </div>`
    )
    .join('');

  foot.hidden = false;
  $('#subtotal').textContent = money(cartSubtotal());
}

function bindDrawerHandlers() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-inc],[data-dec],[data-rm]');
    if (!t) return;
    const key = t.dataset.inc || t.dataset.dec || t.dataset.rm;
    const [id, variant] = key.split('|');
    const line = readCart().find((l) => l.id === id && l.variant === variant);
    if (!line) return;
    if (t.dataset.inc) setQty(id, variant, line.qty + 1);
    if (t.dataset.dec) setQty(id, variant, line.qty - 1);
    if (t.dataset.rm) setQty(id, variant, 0);
  });
  document.addEventListener('cart:change', renderDrawer);
}

function openDrawer() {
  mountChrome();
  $('#cartDrawer').classList.add('on');
  $('#cartDrawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('on');
  document.body.classList.add('no-scroll');
  renderDrawer();
}

function closeDrawer() {
  const d = $('#cartDrawer');
  if (!d) return;
  d.classList.remove('on');
  d.setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('on');
  document.body.classList.remove('no-scroll');
}

/* ---------------- checkout ---------------- */

async function checkout() {
  const btn = $('#checkoutBtn');
  const lines = readCart();
  if (!lines.length) return;

  btn.disabled = true;
  btn.textContent = 'Connecting to Stripe…';

  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: lines.map(({ id, variant, qty }) => ({ id, variant, qty })) })
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.url) {
      window.location.href = data.url;
      return;
    }

    if (res.status === 503 || res.status === 404) {
      toast('Payments aren’t connected yet — see docs/DEPLOY.md step 4.');
    } else {
      toast(data.error || 'Something went wrong. Please try again.');
    }
  } catch {
    toast('No connection to the checkout service.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Checkout';
  }
}

/* ---------------- nav ---------------- */

function initNav() {
  const nav = $('#nav');
  if (!nav) return;

  const mobile = $('#mobileMenu');
  const burger = $('#burger');

  if (burger && mobile) {
    burger.addEventListener('click', () => mobile.classList.toggle('open'));
    $$('a', mobile).forEach((a) => a.addEventListener('click', () => mobile.classList.remove('open')));
  }

  // the bar takes its colour from whatever section sits behind it
  const zones = $$('.hero, .dark, .footer');

  const update = () => {
    const mid = nav.offsetHeight / 2;
    let zone = null;
    for (const el of zones) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) {
        zone = el;
        break;
      }
    }
    const overHero = Boolean(zone && zone.classList.contains('hero'));
    const overDark = Boolean(zone && !overHero);
    const solid = !overHero && !overDark;

    nav.classList.toggle('on-dark', overDark);
    nav.classList.toggle('solid', solid);
  };

  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
}

/* ---------------- reveal ---------------- */

function initReveal() {
  const els = $$('.reveal');
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) {
    els.forEach((e) => e.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
  );
  els.forEach((e) => io.observe(e));
}

/* ---------------- index page ---------------- */

function renderCollection() {
  const grid = $('#collectionGrid');
  if (!grid || !CATALOG) return;
  grid.innerHTML = CATALOG.products
    .map(
      (p) => `<a class="tile reveal" href="/product.html?id=${p.id}">
        <div class="tile-media">
          ${p.badge ? `<span class="tile-badge">${p.badge}</span>` : ''}
          <img src="${p.image}" alt="${p.name}" loading="lazy">
        </div>
        <div class="tile-body">
          <h3>${p.name}</h3>
          <div class="tile-price">${money(p.price)}${p.compareAt ? ` <s>${money(p.compareAt)}</s>` : ''}</div>
          <span class="link-arrow">Shop ${ICON.arrow}</span>
        </div>
      </a>`
    )
    .join('');
  initReveal();
}

/* ---------------- product page ---------------- */

function renderProduct() {
  const root = $('#pdp');
  if (!root || !CATALOG) return;

  const id = new URLSearchParams(location.search).get('id');
  const p = findProduct(id) || CATALOG.products[0];
  if (!p) return;

  document.title = `${p.name} — ALIGN`;
  let variant = (p.variants && p.variants[0].label) || 'Standard';
  let qty = 1;

  root.innerHTML = `
    <div class="crumbs"><a href="/">Home</a> <span>/</span> <a href="/#collection">Collection</a> <span>/</span> <span class="muted">${p.name}</span></div>
    <div class="pdp-grid">
      <div class="pdp-media reveal">
        <img src="${p.image}" alt="${p.name}">
      </div>
      <div class="reveal">
        <p class="eyebrow">${p.eyebrow}</p>
        <h1>${p.name}</h1>
        <p class="pdp-tagline">${p.tagline}</p>
        <div class="pdp-price">
          <span id="pdpPrice">${money(p.price)}</span>
          ${p.compareAt ? `<s>${money(p.compareAt)}</s><span class="save">Save ${money(p.compareAt - p.price)}</span>` : ''}
        </div>

        <div class="field-label">Colour / size <em id="variantLabel">${variant}</em></div>
        <div class="variants" id="variants">
          ${(p.variants || [])
            .map(
              (v, i) =>
                `<button class="variant" aria-pressed="${i === 0}" data-v="${v.label}">${v.label}</button>`
            )
            .join('')}
        </div>

        <div class="pdp-buy">
          <div class="qty">
            <button id="qDec" aria-label="Decrease quantity">−</button>
            <span id="qVal">1</span>
            <button id="qInc" aria-label="Increase quantity">+</button>
          </div>
          <button class="btn btn-primary" id="addBtn">Add to bag</button>
        </div>

        <div class="pdp-notes">
          <div>${ICON.truck} Free shipping — arrives in ${CATALOG.shipping.estimate}</div>
          <div>${ICON.shield} ${CATALOG.shipping.returns} on every order</div>
          <div>${ICON.lock} Encrypted checkout by Stripe</div>
        </div>

        <div class="pdp-accordion">
          <details open><summary>What it does</summary><div class="body"><p>${p.summary}</p><ul>${p.bullets.map((b) => `<li>${b}</li>`).join('')}</ul></div></details>
          <details><summary>Specifications</summary><div class="body"><table class="spec-table">${p.specs
            .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
            .join('')}</table></div></details>
          <details><summary>Shipping &amp; returns</summary><div class="body">
            <p>Every order ships free, worldwide. Most orders arrive in ${CATALOG.shipping.estimate}, and you get a tracking link the moment your parcel leaves the warehouse.</p>
            <p>If it isn’t right, return it within 30 days for a full refund — we’ll send the return label.</p>
          </div></details>
        </div>
      </div>
    </div>`;

  const priceEl = $('#pdpPrice');
  const variantLabel = $('#variantLabel');
  const qVal = $('#qVal');

  const paintPrice = () => (priceEl.textContent = money(unitPrice(p, variant)));

  $$('#variants .variant').forEach((b) =>
    b.addEventListener('click', () => {
      variant = b.dataset.v;
      $$('#variants .variant').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      variantLabel.textContent = variant;
      paintPrice();
    })
  );

  $('#qDec').addEventListener('click', () => {
    qty = Math.max(1, qty - 1);
    qVal.textContent = qty;
  });
  $('#qInc').addEventListener('click', () => {
    qty = Math.min(20, qty + 1);
    qVal.textContent = qty;
  });

  $('#addBtn').addEventListener('click', () => {
    addToCart(p.id, variant, qty);
    openDrawer();
  });

  // related products
  const rel = $('#related');
  if (rel) {
    rel.innerHTML = CATALOG.products
      .filter((x) => x.id !== p.id)
      .slice(0, 3)
      .map(
        (x) => `<a class="tile" href="/product.html?id=${x.id}">
          <div class="tile-media"><img src="${x.image}" alt="${x.name}" loading="lazy"></div>
          <div class="tile-body"><h3>${x.name}</h3><div class="tile-price">${money(x.price)}</div></div>
        </a>`
      )
      .join('');
  }

  initReveal();
}

/* ---------------- boot ---------------- */

async function boot() {
  mountChrome();
  bindDrawerHandlers();
  initNav();

  try {
    await loadCatalog();
  } catch {
    console.warn('Catalog failed to load');
  }

  renderCollection();
  renderProduct();
  renderDrawer();
  initReveal();
  document.addEventListener('cart:change', renderDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // gentle 3D drift on the hero shot
  const fig = $('.hero-figure');
  if (fig && window.matchMedia('(pointer:fine)').matches) {
    const img = $('.hero-shot', fig);
    if (img)
      fig.addEventListener('mousemove', (e) => {
        const r = fig.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        img.style.transform = `rotateY(${x * 8}deg) rotateX(${-y * 6}deg) scale(1.01)`;
      });
    fig.addEventListener('mouseleave', () => {
      if (img) img.style.transform = '';
    });
  }

  // success page order reference
  const ref = $('#orderRef');
  if (ref) {
    const sid = new URLSearchParams(location.search).get('session_id') || '';
    ref.textContent = sid ? `#${sid.slice(-10).toUpperCase()}` : '#—';
    localStorage.removeItem(CART_KEY);
    document.dispatchEvent(new CustomEvent('cart:change'));
  }

  // footer year
  const year = $('#year');
  if (year) year.textContent = new Date().getFullYear();
}

document.addEventListener('DOMContentLoaded', boot);
