const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ENV_FILE = path.join(ROOT, ".env");
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const PORT = Number(process.env.PORT || 4173);
const DB_FILE = path.resolve(ROOT, process.env.DB_PATH || "./data/smartcart.sqlite");
const MAX_BODY_BYTES = 64 * 1024;
const USD_TO_PKR_RATE = 280;
const CURRENCY_SCALE = 100;
const FREE_STANDARD_SHIPPING_THRESHOLD = 42000 * CURRENCY_SCALE;
const STANDARD_SHIPPING_COST = 2240 * CURRENCY_SCALE;
const ADMIN_EMAIL = (process.env.SMARTCART_ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.SMARTCART_ADMIN_PASSWORD || "";
const ADMIN_PASSWORD_HASH = ADMIN_PASSWORD.length >= 12
  ? scryptSync(ADMIN_PASSWORD, `smartcart-admin:${ADMIN_EMAIL}`, 64)
  : null;
const PAYMENT_RECIPIENT_NAME = (process.env.SMARTCART_PAYMENT_RECIPIENT_NAME || "").trim().slice(0, 100);
const PAYMENT_RECIPIENT_NUMBER = (process.env.SMARTCART_PAYMENT_RECIPIENT_NUMBER || "").trim().slice(0, 40);
const PAYMENT_PROOF_WHATSAPP_NUMBER = (process.env.SMARTCART_PAYMENT_PROOF_WHATSAPP_NUMBER || "03147415741").trim().slice(0, 40);
const rateLimits = new Map();

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    compare_at_cents INTEGER,
    image TEXT NOT NULL,
    color TEXT NOT NULL,
    sizes TEXT NOT NULL,
    badge TEXT,
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    rating REAL NOT NULL DEFAULT 0,
    reviews INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_number TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    postal_code TEXT NOT NULL,
    country TEXT NOT NULL,
    phone TEXT NOT NULL,
    shipping_method TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    shipping_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    payment_status TEXT NOT NULL DEFAULT 'Pending',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS manual_orders (
    id TEXT PRIMARY KEY,
    tracking_id TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL,
    items_summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Confirmed',
    admin_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_items (
    order_id TEXT NOT NULL REFERENCES orders(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    size TEXT NOT NULL,
    PRIMARY KEY (order_id, product_id, size)
  );
  CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    email TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'New',
    admin_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_hash TEXT NOT NULL,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    content TEXT NOT NULL,
    image TEXT NOT NULL,
    author TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT
  );
  CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
if (!orderColumns.includes("admin_notes")) db.exec("ALTER TABLE orders ADD COLUMN admin_notes TEXT NOT NULL DEFAULT ''");
if (!orderColumns.includes("payment_status")) db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'Pending'");
db.exec("UPDATE orders SET status = 'Processing' WHERE status = 'Confirmed'; UPDATE orders SET status = 'Delivering' WHERE status = 'Shipped'");

function migrateLegacyUsdPrices(database) {
  const migrationKey = "currency_usd_to_pkr_v1";
  database.exec("BEGIN IMMEDIATE");
  try {
    if (database.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(migrationKey)) {
      database.exec("COMMIT");
      return false;
    }
    database.prepare(`
      UPDATE products
      SET price_cents = price_cents * ?, compare_at_cents = CASE
        WHEN compare_at_cents IS NULL THEN NULL ELSE compare_at_cents * ? END
    `).run(USD_TO_PKR_RATE, USD_TO_PKR_RATE);
    database.prepare(`
      UPDATE orders
      SET subtotal_cents = subtotal_cents * ?, shipping_cents = shipping_cents * ?,
        tax_cents = tax_cents * ?, total_cents = total_cents * ?
    `).run(USD_TO_PKR_RATE, USD_TO_PKR_RATE, USD_TO_PKR_RATE, USD_TO_PKR_RATE);
    database.prepare("UPDATE order_items SET unit_price_cents = unit_price_cents * ?").run(USD_TO_PKR_RATE);
    database.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run(migrationKey, `USD to PKR at ${USD_TO_PKR_RATE}:1`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return true;
}

migrateLegacyUsdPrices(db);

const seedProducts = [
  ["arc-knit", "arc-knit", "Arc Knit Cardigan", "Clothing", "A soft, sculptural knit made for slow mornings and long weekends.", 12800, 16000, "photo-1434389677669-e08b4cac3105", "Oatmeal", '["XS","S","M","L","XL"]', "Bestseller", 18, 4.9, 42],
  ["everyday-tote", "everyday-tote", "Everyday Carryall", "Accessories", "An easy, roomy carryall in supple recycled cotton canvas.", 6800, null, "photo-1544816155-12df9643f363", "Cocoa", '["One size"]', "New", 24, 4.8, 28],
  ["cloud-sneaker", "cloud-sneaker", "Cloud Walk Sneaker", "Shoes", "Lightweight everyday sneakers with a cushioned, considered fit.", 11200, null, "photo-1542291026-7eec264c27ff", "Chalk / Sage", '["36","37","38","39","40","41"]', null, 16, 4.7, 36],
  ["studio-shirt", "studio-shirt", "Studio Linen Shirt", "Clothing", "Breezy European linen with a relaxed shape and mother-of-pearl buttons.", 9400, 11800, "photo-1598554747436-c9293d6a588f", "Soft White", '["XS","S","M","L","XL"]', "Sale", 14, 4.8, 19],
  ["form-vase", "form-vase", "Form Ceramic Vase", "Home", "A hand-finished stoneware form that brings a little calm to any room.", 5400, null, "photo-1578500494198-246f612d3b3d", "Warm Sand", '["One size"]', "Limited", 9, 5.0, 12],
  ["weekender", "weekender", "The Weekender", "Accessories", "A thoughtfully organized overnight bag for the little escapes.", 15600, null, "photo-1553062407-98eeb64c6a62", "Olive", '["One size"]', null, 11, 4.9, 31],
  ["rib-tank", "rib-tank", "Ribbed Everyday Tank", "Clothing", "A beautifully simple, fitted layer in breathable organic cotton.", 4200, null, "photo-1503342217505-b0a15ec3261c", "Terracotta", '["XS","S","M","L","XL"]', null, 32, 4.6, 24],
  ["sun-hat", "sun-hat", "Sunday Sun Hat", "Accessories", "Packable raffia with a wide brim for unhurried afternoons outdoors.", 7200, null, "photo-1521369909029-2afed882baee", "Natural", '["S/M","L/XL"]', "Bestseller", 20, 4.9, 17],
  ["harbor-trench", "harbor-trench", "Harbor Cotton Trench", "Clothing", "A light, easy layer with a relaxed shape for in-between weather.", 18400, 22000, "photo-1548126032-079a0fb0099d", "Warm Stone", '["XS","S","M","L","XL"]', "New", 8, 4.8, 11],
  ["weekend-knit", "weekend-knit", "Weekend Cotton Knit", "Clothing", "A breathable everyday knit with a soft hand and an easy drape.", 8900, null, "photo-1576566588028-4147f3842f27", "Sea Glass", '["XS","S","M","L","XL"]', null, 15, 4.7, 9],
  ["soft-structured-cap", "soft-structured-cap", "Soft Structured Cap", "Accessories", "A comfortable cotton cap with a clean profile and adjustable strap.", 3600, null, "photo-1588850561407-ed78c282e89b", "Washed Navy", '["One size"]', "Everyday", 22, 4.6, 14],
  ["woven-crossbody", "woven-crossbody", "Woven Crossbody Bag", "Accessories", "A hands-free woven bag sized for the things you take everywhere.", 7600, null, "photo-1590874103328-eac38a683ce7", "Natural", '["One size"]', null, 12, 4.8, 8],
  ["garden-mug-set", "garden-mug-set", "Garden Stoneware Mugs", "Home", "A pair of tactile stoneware mugs for slow starts and long conversations.", 4800, null, "photo-1514228742587-6b1558fcca3d", "Soft White", '["Set of 2"]', "New", 13, 4.9, 7],
  ["linen-cushion", "linen-cushion", "Washed Linen Cushion", "Home", "A softly textured linen cushion cover in a versatile, relaxed neutral.", 5200, null, "photo-1584100936595-c0654b55a2e2", "Warm Sand", '["45 × 45 cm"]', null, 10, 4.7, 6],
  ["everyday-bowl", "everyday-bowl", "Everyday Ceramic Bowl", "Home", "A versatile hand-finished bowl for breakfast, snacks, and supper.", 3200, null, "photo-1578749556568-bc2c40e68b61", "Oatmeal", '["One size"]', null, 18, 4.8, 5],
  ["canvas-slip-on", "canvas-slip-on", "Canvas Slip-On", "Shoes", "Easy canvas slip-ons with a flexible sole for everyday wandering.", 6400, null, "photo-1525966222134-fcfa99b8ae77", "Natural / Ink", '["36","37","38","39","40","41"]', "Easy fit", 17, 4.7, 12],
  ["weekend-runner", "weekend-runner", "Weekend Runner", "Shoes", "A light, cushioned trainer for comfortable miles around town.", 9800, null, "photo-1495555961986-6d4c1ecb7be3", "Clay / Cream", '["36","37","38","39","40","41"]', null, 14, 4.8, 10],
  ["leather-card-holder", "leather-card-holder", "Everyday Card Holder", "Accessories", "A slim card holder made for the pockets and bags you carry daily.", 2900, null, "photo-1627123424574-724758594e93", "Cognac", '["One size"]', null, 25, 4.6, 4],
  ["studio-wireless-headphones", "studio-wireless-headphones", "Studio Wireless Headphones", "Electronics", "Comfortable over-ear headphones with clear sound for work, travel, and quiet moments.", 8900, 10900, "photo-1505740420928-5e560c06d30e", "Matte Black", '["One size"]', "New", 14, 4.8, 18],
  ["pocket-bluetooth-speaker", "pocket-bluetooth-speaker", "Pocket Bluetooth Speaker", "Electronics", "A compact portable speaker with warm sound for your desk or weekend away.", 6200, null, "photo-1608043152269-423dbba4e7e1", "Graphite", '["One size"]', "Everyday", 20, 4.7, 11],
  ["arc-desk-lamp", "arc-desk-lamp", "Arc Rechargeable Desk Lamp", "Electronics", "A softly sculpted rechargeable lamp for reading corners and thoughtful workspaces.", 7400, null, "photo-1507473885765-e6ed057f782c", "Soft Brass", '["One size"]', null, 10, 4.9, 7]
];
const insertProduct = db.prepare(`
  INSERT OR IGNORE INTO products
  (id, slug, name, category, description, price_cents, compare_at_cents, image, color, sizes, badge, stock, rating, reviews)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const product of seedProducts) {
  insertProduct.run(...product.map((value, index) => [5, 6].includes(index) && value !== null
    ? value * USD_TO_PKR_RATE
    : value));
}
const insertCategory = db.prepare("INSERT OR IGNORE INTO categories (id, name, created_at) VALUES (?, ?, ?)");
for (const name of ["Clothing", "Accessories", "Shoes", "Home", "Electronics"]) {
  insertCategory.run(randomUUID(), name, new Date().toISOString());
}
const seedBlogPosts = [
  ["choosing-well-everyday", "A gentler way to choose the things we keep", "A few thoughtful questions can turn an everyday purchase into something you will love for years.", "The best things are often the things we reach for without thinking: a shirt that softens with every wash, a bag that knows its way around town, a small object that makes home feel more like home.\n\nWhen we choose with intention, it helps to slow down for a moment. Will it be useful? Does it feel good to hold and wear? Can it become part of the everyday rather than a passing trend?\n\nWe started SK Wholesaler around these small questions. Not to make shopping complicated, but to help make the lovely, useful things easier to find.", "photo-1490481651871-ab68de25d43d", "SK Wholesaler"],
  ["make-space-for-slower-mornings", "Making a little more room for slower mornings", "A simple ritual, a favourite layer, and a little breathing room can change the start of your day.", "There is no perfect morning routine. There is only the one that gives you a moment to arrive in your day.\n\nMaybe it is putting on your favourite soft knit before the kettle boils. Maybe it is leaving your phone across the room while you open the window. Small, familiar things can make space for a calmer start.\n\nOur favourite everyday pieces are the ones that fit gently into these rituals: comfortable, useful, and quietly well made.", "photo-1490312278390-ab64016e0aa9", "SK Wholesaler"],
  ["care-for-the-things-you-love", "A little care goes a long way", "Simple ways to look after the everyday pieces you reach for again and again.", "Thoughtful care does not need to be complicated. Read the label, wash gently when you can, and give pieces room to air between wears.\n\nFor bags and accessories, a soft cloth and a little patience often do more than a cupboard full of special products. For home objects, dust them regularly and keep them somewhere you enjoy seeing them.\n\nCare is less about keeping things perfect and more about letting them become part of your life.", "photo-1544816155-12df9643f363", "SK Wholesaler"]
];
const insertBlogPost = db.prepare(`
  INSERT OR IGNORE INTO blog_posts
    (id, slug, title, excerpt, content, image, author, status, created_at, updated_at, published_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'Published', ?, ?, ?)
`);
for (const [slug, title, excerpt, content, image, author] of seedBlogPosts) {
  const timestamp = new Date().toISOString();
  insertBlogPost.run(randomUUID(), slug, title, excerpt, content, image, author, timestamp, timestamp, timestamp);
}

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function rateLimited(request, response) {
  const now = Date.now();
  const key = `public:${request.socket.remoteAddress}:${Math.floor(now / 60000)}`;
  const count = rateLimits.get(key) || 0;
  if (count >= 20) {
    json(response, 429, { error: "Too many requests. Please try again in a minute." });
    return true;
  }
  rateLimits.set(key, count + 1);
  if (rateLimits.size > 2000) {
    for (const [entry, amount] of rateLimits) {
      if (Number(entry.split(":").at(-1)) < Math.floor(now / 60000) - 1) rateLimits.delete(entry);
      if (rateLimits.size <= 1000) break;
    }
  }
  return false;
}

function isRateLimited(request, response, namespace, limit) {
  const now = Date.now();
  const key = `${namespace}:${request.socket.remoteAddress}:${Math.floor(now / 60000)}`;
  const count = rateLimits.get(key) || 0;
  if (count >= limit) {
    json(response, 429, { error: "Too many requests. Please try again in a minute." });
    return true;
  }
  rateLimits.set(key, count + 1);
  if (rateLimits.size > 2000) {
    for (const entry of rateLimits.keys()) {
      if (Number(entry.split(":").at(-1)) < Math.floor(now / 60000) - 1) rateLimits.delete(entry);
      if (rateLimits.size <= 1000) break;
    }
  }
  return false;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRequestSecure(request) {
  return Boolean(request.socket.encrypted)
    || (process.env.TRUST_PROXY === "true" && request.headers["x-forwarded-proto"] === "https");
}

function getCookie(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function getAdminSession(request) {
  const token = getCookie(request, "smartcart_admin");
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const session = db.prepare("SELECT token_hash, csrf_hash, email, expires_at FROM admin_sessions WHERE token_hash = ?")
    .get(hashToken(token));
  if (!session || session.expires_at <= new Date().toISOString()) {
    if (session) db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(session.token_hash);
    return null;
  }
  return session;
}

function requireAdmin(request, response, session) {
  if (!session) {
    json(response, 401, { error: "Please sign in to access the admin area." });
    return false;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.origin;
    const expectedOrigin = `${isRequestSecure(request) ? "https" : "http"}://${request.headers.host}`;
    if (origin && origin !== expectedOrigin) {
      json(response, 403, { error: "This request origin is not allowed." });
      return false;
    }
    const csrfToken = String(request.headers["x-csrf-token"] || "");
    if (!/^[a-f0-9]{64}$/.test(csrfToken) || !safeEqual(hashToken(csrfToken), session.csrf_hash)) {
      json(response, 403, { error: "Your admin session expired. Refresh the page and try again." });
      return false;
    }
  }
  return true;
}

function createAdminSession(email) {
  const token = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now.toISOString());
  db.prepare("INSERT INTO admin_sessions (token_hash, csrf_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(hashToken(token), hashToken(csrfToken), email, expiresAt, now.toISOString());
  return { token, csrfToken, expiresAt };
}

function adminLogin(request, response, payload) {
  const email = cleanText(payload.email, 254).toLowerCase();
  const password = typeof payload.password === "string" ? payload.password : "";
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) {
    json(response, 503, { error: "Admin sign-in is not configured. Set SMARTCART_ADMIN_EMAIL and a SMARTCART_ADMIN_PASSWORD of at least 12 characters, then restart the server." });
    return;
  }
  if (password.length > 256 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !safeEqual(email, ADMIN_EMAIL)) {
    json(response, 401, { error: "Email or password is incorrect." });
    return;
  }
  const submittedPassword = scryptSync(password, `smartcart-admin:${ADMIN_EMAIL}`, 64);
  if (!timingSafeEqual(submittedPassword, ADMIN_PASSWORD_HASH)) {
    json(response, 401, { error: "Email or password is incorrect." });
    return;
  }
  const session = createAdminSession(ADMIN_EMAIL);
  const secure = isRequestSecure(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `smartcart_admin=${session.token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=43200${secure}`);
  json(response, 200, { authenticated: true, email: ADMIN_EMAIL, csrfToken: session.csrfToken });
}

function adminCategories() {
  return db.prepare(`
    SELECT categories.id, categories.name, categories.description, categories.created_at,
      COUNT(products.id) AS product_count
    FROM categories LEFT JOIN products ON products.category = categories.name
    GROUP BY categories.id ORDER BY categories.name COLLATE NOCASE
  `).all();
}

function validateCategoryName(value) {
  const name = cleanText(value, 40);
  if (!name || name.length < 2) throw Object.assign(new Error("Category names must contain at least 2 characters."), { status: 400 });
  return name;
}

function updateCategory(id, payload) {
  const category = db.prepare("SELECT id, name FROM categories WHERE id = ?").get(id);
  if (!category) throw Object.assign(new Error("Category not found."), { status: 404 });
  const name = validateCategoryName(payload.name === undefined ? category.name : payload.name);
  const previous = db.prepare("SELECT description FROM categories WHERE id = ?").get(id);
  const description = payload.description === undefined ? previous.description : cleanText(payload.description, 240);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE products SET category = ? WHERE category = ?").run(name, category.name);
    db.prepare("UPDATE categories SET name = ?, description = ? WHERE id = ?").run(name, description, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("A category with that name already exists."), { status: 409 });
    throw error;
  }
  return db.prepare("SELECT id, name, description FROM categories WHERE id = ?").get(id);
}

function productInput(payload) {
  const name = cleanText(payload.name, 120);
  const category = validateCategoryName(payload.category);
  const description = cleanText(payload.description, 1000);
  const color = cleanText(payload.color, 80);
  const image = cleanText(payload.image, 160);
  const badge = cleanText(payload.badge, 30) || null;
  const priceCents = Number(payload.priceCents);
  const compareAtCents = payload.compareAtCents === "" || payload.compareAtCents == null ? null : Number(payload.compareAtCents);
  const stock = Number(payload.stock);
  const sizes = Array.isArray(payload.sizes)
    ? [...new Set(payload.sizes.map((size) => cleanText(size, 20)).filter(Boolean))]
    : [];
  if (!name || !description || !color || !image || !/^photo-[A-Za-z0-9-]+$/.test(image)) {
    throw Object.assign(new Error("Name, description, color, and a valid Unsplash photo ID are required."), { status: 400 });
  }
  if (!db.prepare("SELECT 1 FROM categories WHERE name = ?").get(category)) {
    throw Object.assign(new Error("Choose an existing category."), { status: 400 });
  }
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 100000000
    || (compareAtCents !== null && (!Number.isSafeInteger(compareAtCents) || compareAtCents < 0 || compareAtCents > 100000000))
    || !Number.isInteger(stock) || stock < 0 || stock > 1000000) {
    throw Object.assign(new Error("Price, compare-at price, or stock is invalid."), { status: 400 });
  }
  if (sizes.length < 1 || sizes.length > 20) {
    throw Object.assign(new Error("Add between 1 and 20 sizes or options."), { status: 400 });
  }
  return { name, category, description, color, image, badge, priceCents, compareAtCents, stock, sizes };
}

function adminProduct(id, payload) {
  const product = productInput(payload);
  if (id) {
    if (!db.prepare("SELECT 1 FROM products WHERE id = ?").get(id)) {
      throw Object.assign(new Error("Product not found."), { status: 404 });
    }
    db.prepare(`
      UPDATE products SET name = ?, category = ?, description = ?, price_cents = ?, compare_at_cents = ?,
        image = ?, color = ?, sizes = ?, badge = ?, stock = ? WHERE id = ?
    `).run(product.name, product.category, product.description, product.priceCents, product.compareAtCents,
      product.image, product.color, JSON.stringify(product.sizes), product.badge, product.stock, id);
    return db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  }
  const idValue = randomUUID();
  const slugBase = product.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "product";
  db.prepare(`
    INSERT INTO products (id, slug, name, category, description, price_cents, compare_at_cents, image, color, sizes, badge, stock)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(idValue, `${slugBase}-${idValue.slice(0, 8)}`, product.name, product.category, product.description,
    product.priceCents, product.compareAtCents, product.image, product.color, JSON.stringify(product.sizes), product.badge, product.stock);
  return db.prepare("SELECT * FROM products WHERE id = ?").get(idValue);
}

function adminOrders() {
  return db.prepare(`
    SELECT orders.*, COALESCE(SUM(order_items.quantity), 0) AS item_count,
      GROUP_CONCAT(order_items.product_name || ' × ' || order_items.quantity, ', ') AS items_summary
    FROM orders LEFT JOIN order_items ON order_items.order_id = orders.id
    GROUP BY orders.id ORDER BY orders.created_at DESC LIMIT 200
  `).all();
}

function updateAdminOrder(id, payload) {
  const order = db.prepare("SELECT id, status, admin_notes, payment_status, payment_method FROM orders WHERE id = ?").get(id);
  if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
  const status = cleanText(payload.status, 20);
  const notes = payload.adminNotes === undefined ? order.admin_notes : cleanText(payload.adminNotes, 1000);
  const paymentStatus = payload.paymentStatus === undefined ? order.payment_status : cleanText(payload.paymentStatus, 20);
  if (!["Pending", "Unverified", "Paid", "Rejected", "Refunded"].includes(paymentStatus)) {
    throw Object.assign(new Error("Choose a valid payment status."), { status: 400 });
  }
  const transitions = {
    Pending: ["Pending", "Processing", "Cancelled"],
    Processing: ["Processing", "Delivering", "Cancelled"],
    Delivering: ["Delivering", "Delivered", "Cancelled"],
    Delivered: ["Delivered"],
    Cancelled: ["Cancelled"]
  };
  if (!transitions[order.status] || !transitions[order.status].includes(status)) {
    throw Object.assign(new Error("That order status change is not allowed."), { status: 409 });
  }
  if (status === "Cancelled" && order.payment_status === "Paid" && paymentStatus !== "Refunded") {
    throw Object.assign(new Error("Mark a paid order as refunded before cancelling it."), { status: 409 });
  }
  if (order.status === "Cancelled" && paymentStatus !== order.payment_status) {
    throw Object.assign(new Error("Payment status cannot be changed after an order is cancelled."), { status: 409 });
  }
  if (["Delivering", "Delivered"].includes(status)
    && ["JazzCash (manual)", "Bank transfer (manual)"].includes(order.payment_method)
    && paymentStatus !== "Paid") {
    throw Object.assign(new Error("Verify the manual payment before shipping this order."), { status: 409 });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (status === "Cancelled" && order.status !== "Cancelled") {
      const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(id);
      const restore = db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?");
      for (const item of items) restore.run(item.quantity, item.product_id);
    }
    db.prepare("UPDATE orders SET status = ?, admin_notes = ?, payment_status = ? WHERE id = ?")
      .run(status, notes, paymentStatus, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db.prepare("SELECT id, order_number, status, payment_status, admin_notes FROM orders WHERE id = ?").get(id);
}

const MANUAL_ORDER_STATUSES = ["Confirmed", "Preparing", "Ready for dispatch", "Dispatched", "Delivered", "Cancelled"];

function adminManualOrders() {
  return db.prepare("SELECT * FROM manual_orders ORDER BY created_at DESC LIMIT 500").all();
}

function createManualOrder(payload) {
  const requestedTrackingId = cleanText(payload.trackingId, 32).toUpperCase();
  const customerName = cleanText(payload.customerName, 100);
  const whatsappNumber = cleanText(payload.whatsappNumber, 40);
  const digits = whatsappNumber.replace(/\D/g, "");
  const itemsSummary = cleanText(payload.itemsSummary, 2000);
  if (!customerName || digits.length < 7 || digits.length > 15 || !itemsSummary
    || (requestedTrackingId && !/^[A-Z0-9]{6,32}$/.test(requestedTrackingId))) {
    throw Object.assign(new Error("Enter a 6-32 character alphanumeric tracking ID, the customer name, a valid WhatsApp number, and the confirmed order details."), { status: 400 });
  }
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < (requestedTrackingId ? 1 : 5); attempt += 1) {
    const trackingId = requestedTrackingId || randomBytes(10).toString("hex").toUpperCase();
    try {
      db.prepare(`
        INSERT INTO manual_orders (id, tracking_id, customer_name, whatsapp_number, items_summary, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'Confirmed', ?, ?)
      `).run(randomUUID(), trackingId, customerName, whatsappNumber, itemsSummary, now, now);
      return db.prepare("SELECT * FROM manual_orders WHERE tracking_id = ?").get(trackingId);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        if (requestedTrackingId) {
          throw Object.assign(new Error("That tracking ID is already in use. Choose another ID."), { status: 409 });
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not generate a unique tracking ID. Please try again.");
}

function updateManualOrder(id, payload) {
  const order = db.prepare("SELECT id, status, admin_notes FROM manual_orders WHERE id = ?").get(id);
  if (!order) throw Object.assign(new Error("Tracking record not found."), { status: 404 });
  const status = cleanText(payload.status, 40);
  const adminNotes = payload.adminNotes === undefined ? order.admin_notes : cleanText(payload.adminNotes, 1000);
  if (!MANUAL_ORDER_STATUSES.includes(status)) {
    throw Object.assign(new Error("Choose a valid tracking status."), { status: 400 });
  }
  db.prepare("UPDATE manual_orders SET status = ?, admin_notes = ?, updated_at = ? WHERE id = ?")
    .run(status, adminNotes, new Date().toISOString(), id);
  return db.prepare("SELECT * FROM manual_orders WHERE id = ?").get(id);
}

function deleteManualOrder(id) {
  const result = db.prepare("DELETE FROM manual_orders WHERE id = ?").run(id);
  if (!result.changes) throw Object.assign(new Error("Tracking record not found."), { status: 404 });
}

function trackManualOrder(value) {
  const trackingId = cleanText(value, 40).toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(trackingId)) {
    throw Object.assign(new Error("Enter a valid 6-32 character alphanumeric tracking ID."), { status: 400 });
  }
  const order = db.prepare(`
    SELECT tracking_id, items_summary, status, created_at, updated_at
    FROM manual_orders WHERE tracking_id = ?
  `).get(trackingId);
  if (!order) throw Object.assign(new Error("We couldn't find a tracking record with that ID."), { status: 404 });
  return order;
}

function adminInquiries() {
  return db.prepare("SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 200").all();
}

function getPublicBlogPosts() {
  return db.prepare(`
    SELECT slug, title, excerpt, content, image, author, published_at
    FROM blog_posts WHERE status = 'Published'
    ORDER BY published_at DESC LIMIT 100
  `).all();
}

function getPublicBlogPost(slug) {
  const post = db.prepare(`
    SELECT slug, title, excerpt, content, image, author, published_at
    FROM blog_posts WHERE slug = ? AND status = 'Published'
  `).get(slug);
  if (!post) throw Object.assign(new Error("That story could not be found."), { status: 404 });
  return post;
}

function adminBlogPosts() {
  return db.prepare("SELECT * FROM blog_posts ORDER BY updated_at DESC LIMIT 200").all();
}

function blogPostInput(payload) {
  const title = cleanText(payload.title, 160);
  const excerpt = cleanText(payload.excerpt, 320);
  const content = cleanText(payload.content, 15000);
  const image = cleanText(payload.image, 160);
  const author = cleanText(payload.author, 100);
  const status = cleanText(payload.status, 20);
  if (!title || !excerpt || content.length < 20 || !author || !/^photo-[A-Za-z0-9-]+$/.test(image)) {
    throw Object.assign(new Error("Title, excerpt, article text, author, and a valid Unsplash photo ID are required."), { status: 400 });
  }
  if (!["Draft", "Published"].includes(status)) {
    throw Object.assign(new Error("Choose Draft or Published."), { status: 400 });
  }
  return { title, excerpt, content, image, author, status };
}

function createBlogPost(payload) {
  const post = blogPostInput(payload);
  const id = randomUUID();
  const slugBase = post.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "story";
  const slug = `${slugBase}-${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO blog_posts (id, slug, title, excerpt, content, image, author, status, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, slug, post.title, post.excerpt, post.content, post.image, post.author, post.status, now, now,
    post.status === "Published" ? now : null);
  return db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(id);
}

function updateBlogPost(id, payload) {
  const existing = db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(id);
  if (!existing) throw Object.assign(new Error("Blog post not found."), { status: 404 });
  const post = blogPostInput(payload);
  const now = new Date().toISOString();
  const publishedAt = post.status === "Published" ? existing.published_at || now : null;
  db.prepare(`
    UPDATE blog_posts
    SET title = ?, excerpt = ?, content = ?, image = ?, author = ?, status = ?, updated_at = ?, published_at = ?
    WHERE id = ?
  `).run(post.title, post.excerpt, post.content, post.image, post.author, post.status, now, publishedAt, id);
  return db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(id);
}

function deleteBlogPost(id) {
  const result = db.prepare("DELETE FROM blog_posts WHERE id = ?").run(id);
  if (Number(result.changes) !== 1) throw Object.assign(new Error("Blog post not found."), { status: 404 });
}

function updateInquiry(id, payload) {
  const inquiry = db.prepare("SELECT id, admin_notes FROM inquiries WHERE id = ?").get(id);
  if (!inquiry) throw Object.assign(new Error("Inquiry not found."), { status: 404 });
  const status = cleanText(payload.status, 20);
  const notes = payload.adminNotes === undefined ? inquiry.admin_notes : cleanText(payload.adminNotes, 1000);
  if (!["New", "In progress", "Resolved"].includes(status)) {
    throw Object.assign(new Error("Choose a valid inquiry status."), { status: 400 });
  }
  db.prepare("UPDATE inquiries SET status = ?, admin_notes = ? WHERE id = ?").run(status, notes, id);
  return db.prepare("SELECT id, status, admin_notes FROM inquiries WHERE id = ?").get(id);
}

function createInquiry(payload) {
  const fullName = cleanText(payload.fullName, 100);
  const email = cleanText(payload.email, 254).toLowerCase();
  const subject = cleanText(payload.subject, 120);
  const message = cleanText(payload.message, 3000);
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !subject || message.length < 10) {
    throw Object.assign(new Error("Please provide your name, a valid email, a subject, and a message of at least 10 characters."), { status: 400 });
  }
  const id = randomUUID();
  db.prepare("INSERT INTO inquiries (id, full_name, email, subject, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, fullName, email, subject, message, new Date().toISOString());
  return db.prepare("SELECT * FROM inquiries WHERE id = ?").get(id);
}

function adminDashboard() {
  const today = new Date();
  const firstDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 13));
  const startDate = firstDay.toISOString().slice(0, 10);
  const salesByDay = new Map(db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, SUM(total_cents) AS sales_cents, COUNT(*) AS order_count
    FROM orders
    WHERE status != 'Cancelled' AND created_at >= ?
    GROUP BY substr(created_at, 1, 10)
  `).all(`${startDate}T00:00:00.000Z`).map((row) => [row.day, row]));
  const sales = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(firstDay.getTime() + index * 24 * 60 * 60 * 1000);
    const day = date.toISOString().slice(0, 10);
    const value = salesByDay.get(day);
    return { day, salesCents: value?.sales_cents || 0, orderCount: value?.order_count || 0 };
  });
  return {
    orderCount: db.prepare("SELECT COUNT(*) AS count FROM orders").get().count,
    pendingOrders: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('Pending', 'Processing')").get().count,
    grossSalesCents: db.prepare("SELECT COALESCE(SUM(total_cents), 0) AS total FROM orders WHERE status != 'Cancelled'").get().total,
    productCount: db.prepare("SELECT COUNT(*) AS count FROM products").get().count,
    lowStock: db.prepare("SELECT COUNT(*) AS count FROM products WHERE stock <= 5").get().count,
    newInquiries: db.prepare("SELECT COUNT(*) AS count FROM inquiries WHERE status = 'New'").get().count,
    sales
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          settled = true;
          reject(Object.assign(new Error("Request body must be a JSON object."), { status: 400 }));
          return;
        }
        resolve(payload);
      } catch {
        settled = true;
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function moneyText(cents) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    currencyDisplay: "code",
    maximumFractionDigits: 0
  })
    .format(cents / CURRENCY_SCALE);
}

function paymentOptions() {
  const transferConfigured = Boolean(PAYMENT_RECIPIENT_NAME && PAYMENT_RECIPIENT_NUMBER);
  return {
    methods: [
      { id: "cod", label: "Cash on delivery", available: true },
      { id: "jazzcash", label: "JazzCash", available: true },
      { id: "bank-transfer", label: "Bank transfer", available: true }
    ],
    recipient: transferConfigured
      ? { name: PAYMENT_RECIPIENT_NAME, number: PAYMENT_RECIPIENT_NUMBER }
      : null,
    paymentProofWhatsAppNumber: PAYMENT_PROOF_WHATSAPP_NUMBER
  };
}

function getProducts(url) {
  const search = cleanText(url.searchParams.get("q") || "", 100);
  const category = cleanText(url.searchParams.get("category") || "", 40);
  const sort = url.searchParams.get("sort");
  const clauses = [];
  const values = [];
  if (search) {
    clauses.push("(name LIKE ? OR description LIKE ? OR category LIKE ?)");
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (category && category !== "All") {
    clauses.push("category = ?");
    values.push(category);
  }
  const orderBy = sort === "price-low" ? "price_cents ASC"
    : sort === "price-high" ? "price_cents DESC"
      : sort === "top-rated" ? "rating DESC"
        : "id ASC";
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM products ${where} ORDER BY ${orderBy}`).all(...values)
    .map((product) => ({ ...product, sizes: JSON.parse(product.sizes) }));
}

function createOrder(payload) {
  const customer = payload.customer || {};
  const fullName = cleanText(customer.fullName, 100);
  const email = cleanText(customer.email, 254).toLowerCase();
  const address = cleanText(customer.address, 200);
  const city = cleanText(customer.city, 100);
  const postalCode = cleanText(customer.postalCode, 20);
  const country = cleanText(customer.country, 80);
  const phone = cleanText(customer.phone, 30);
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !address || !city || !postalCode || !country || !phone) {
    throw Object.assign(new Error("Please provide a valid email and complete shipping details."), { status: 400 });
  }
  const shipping = { method: "Standard shipping", cents: STANDARD_SHIPPING_COST };
  const paymentMethods = {
    cod: "Cash on delivery",
    jazzcash: "JazzCash (manual)",
    "bank-transfer": "Bank transfer (manual)"
  };
  if (!Object.hasOwn(paymentMethods, payload.paymentMethod)) {
    throw Object.assign(new Error("Choose cash on delivery, JazzCash, or bank transfer."), { status: 400 });
  }
  const paymentMethod = paymentMethods[payload.paymentMethod];
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 30) {
    throw Object.assign(new Error("Your cart is empty or contains too many items."), { status: 400 });
  }

  const lineItems = [];
  const seen = new Set();
  for (const item of payload.items) {
    const productId = cleanText(item.productId, 80);
    const size = cleanText(item.size, 20);
    const quantity = Number(item.quantity);
    if (!productId || !size || !Number.isInteger(quantity) || quantity < 1 || quantity > 10 || seen.has(`${productId}:${size}`)) {
      throw Object.assign(new Error("One or more cart items are invalid."), { status: 400 });
    }
    seen.add(`${productId}:${size}`);
    const product = db.prepare("SELECT id, name, price_cents, sizes, stock FROM products WHERE id = ?").get(productId);
    if (!product || !JSON.parse(product.sizes).includes(size)) {
      throw Object.assign(new Error("A product or selected size is no longer available. Please refresh your cart."), { status: 400 });
    }
    if (product.stock < quantity) {
      throw Object.assign(new Error(`${product.name} does not have enough stock for the requested quantity.`), { status: 409 });
    }
    lineItems.push({ ...product, size, quantity });
  }

  const subtotal = lineItems.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
  const shippingCents = shipping.method === "Standard shipping" && subtotal >= FREE_STANDARD_SHIPPING_THRESHOLD ? 0 : shipping.cents;
  const tax = Math.round(subtotal * 0.08);
  const total = subtotal + shippingCents + tax;
  const id = randomUUID();
  const orderNumber = `SC-${randomBytes(8).toString("hex").toUpperCase()}`;
  const createdAt = new Date().toISOString();
  const insertOrder = db.prepare(`
    INSERT INTO orders (id, order_number, email, full_name, address, city, postal_code, country, phone,
      shipping_method, payment_method, subtotal_cents, shipping_cents, tax_cents, total_cents, status, payment_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price_cents, size)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const decrementStock = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?");

  db.exec("BEGIN IMMEDIATE");
  try {
    const paymentStatus = payload.paymentMethod === "cod" ? "Pending" : "Unverified";
    insertOrder.run(id, orderNumber, email, fullName, address, city, postalCode, country, phone,
      shipping.method, paymentMethod, subtotal, shippingCents, tax, total, paymentStatus, createdAt);
    for (const item of lineItems) {
      const result = decrementStock.run(item.quantity, item.id, item.quantity);
      if (Number(result.changes) !== 1) {
        throw Object.assign(new Error(`${item.name} just sold out. Please update your cart.`), { status: 409 });
      }
      insertItem.run(id, item.id, item.name, item.quantity, item.price_cents, item.size);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    orderNumber,
    email,
    fullName,
    shippingMethod: shipping.method,
    paymentMethod,
    paymentStatus: payload.paymentMethod === "cod" ? "Pending" : "Unverified",
    paymentProofWhatsAppNumber: PAYMENT_PROOF_WHATSAPP_NUMBER,
    paymentInstructions: payload.paymentMethod === "cod"
      ? "Pay the delivery driver when your order arrives."
      : PAYMENT_RECIPIENT_NAME && PAYMENT_RECIPIENT_NUMBER
        ? `Send ${moneyText(total)} to ${PAYMENT_RECIPIENT_NAME} at ${PAYMENT_RECIPIENT_NUMBER} using ${paymentMethod.startsWith("JazzCash") ? "JazzCash" : "your bank's supported transfer service"}. Your payment will be verified by the store team.`
        : "Contact the store team for payment details before sending money. Your payment remains unverified until the store confirms it.",
    subtotalCents: subtotal,
    shippingCents,
    taxCents: tax,
    totalCents: total,
    status: "Pending",
    createdAt,
    items: lineItems.map((item) => ({ name: item.name, quantity: item.quantity, size: item.size, priceCents: item.price_cents }))
  };
}

function trackOrder(payload) {
  const orderNumber = cleanText(payload.orderNumber, 60).toUpperCase();
  const email = cleanText(payload.email, 254).toLowerCase();
  if (!orderNumber || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("Enter a valid order number and email address."), { status: 400 });
  }
  const order = db.prepare(`
    SELECT order_number, email, full_name, shipping_method, payment_method, total_cents, status, created_at
    FROM orders WHERE order_number = ? AND email = ?
  `).get(orderNumber, email);
  if (!order) throw Object.assign(new Error("We couldn't find an order matching those details."), { status: 404 });
  const items = db.prepare("SELECT product_name AS name, quantity, size, unit_price_cents AS priceCents FROM order_items WHERE order_id = (SELECT id FROM orders WHERE order_number = ?)").all(orderNumber);
  return { ...order, items };
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  })[extension] || "application/octet-stream";
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { status: "ok", store: "SK Wholesaler" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/products") {
        json(response, 200, { products: getProducts(url) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/payment-options") {
        json(response, 200, paymentOptions());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/blogs") {
        json(response, 200, { posts: getPublicBlogPosts() });
        return;
      }
      const publicBlogMatch = url.pathname.match(/^\/api\/blogs\/([^/]+)$/);
      if (request.method === "GET" && publicBlogMatch) {
        json(response, 200, { post: getPublicBlogPost(decodeURIComponent(publicBlogMatch[1])) });
        return;
      }
      if (url.pathname === "/api/admin/session" && request.method === "GET") {
        const session = getAdminSession(request);
        if (!session) {
          json(response, 200, { authenticated: false });
          return;
        }
        const csrfToken = randomBytes(32).toString("hex");
        db.prepare("UPDATE admin_sessions SET csrf_hash = ? WHERE token_hash = ?").run(hashToken(csrfToken), session.token_hash);
        json(response, 200, { authenticated: true, email: session.email, csrfToken });
        return;
      }
      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        if (isRateLimited(request, response, "admin-login", 8)) return;
        if (!String(request.headers["content-type"] || "").includes("application/json")) {
          json(response, 415, { error: "Content-Type must be application/json." });
          return;
        }
        adminLogin(request, response, await readJson(request));
        return;
      }
      if (url.pathname.startsWith("/api/admin/")) {
        const session = getAdminSession(request);
        if (!requireAdmin(request, response, session)) return;
        if (request.method === "POST" && url.pathname === "/api/admin/logout") {
          db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(session.token_hash);
          const secure = isRequestSecure(request) ? "; Secure" : "";
          response.setHeader("Set-Cookie", `smartcart_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure}`);
          json(response, 200, { authenticated: false });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/admin/dashboard") {
          json(response, 200, { dashboard: adminDashboard() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/admin/products") {
          json(response, 200, { products: getProducts(new URL("http://localhost/api/products?sort=featured")) });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/admin/categories") {
          json(response, 200, { categories: adminCategories() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/admin/orders") {
          json(response, 200, { orders: adminOrders() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/admin/manual-orders") {
          json(response, 200, { orders: adminManualOrders() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/admin/inquiries") {
          json(response, 200, { inquiries: adminInquiries() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/admin/blogs") {
          json(response, 200, { posts: adminBlogPosts() });
          return;
        }
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
          json(response, 404, { error: "Admin endpoint not found." });
          return;
        }
        if (!String(request.headers["content-type"] || "").includes("application/json") && request.method !== "DELETE") {
          json(response, 415, { error: "Content-Type must be application/json." });
          return;
        }
        const payload = request.method === "DELETE" ? {} : await readJson(request);
        if (request.method === "POST" && url.pathname === "/api/admin/manual-orders") {
          json(response, 201, { order: createManualOrder(payload) });
          return;
        }
        const manualOrderMatch = url.pathname.match(/^\/api\/admin\/manual-orders\/([^/]+)$/);
        if (manualOrderMatch && request.method === "PATCH") {
          json(response, 200, { order: updateManualOrder(decodeURIComponent(manualOrderMatch[1]), payload) });
          return;
        }
        if (manualOrderMatch && request.method === "DELETE") {
          deleteManualOrder(decodeURIComponent(manualOrderMatch[1]));
          json(response, 200, { deleted: true });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/admin/categories") {
          const name = validateCategoryName(payload.name);
          const description = cleanText(payload.description, 240);
          const id = randomUUID();
          try {
            db.prepare("INSERT INTO categories (id, name, description, created_at) VALUES (?, ?, ?, ?)")
              .run(id, name, description, new Date().toISOString());
          } catch (error) {
            if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("A category with that name already exists."), { status: 409 });
            throw error;
          }
          json(response, 201, { category: db.prepare("SELECT id, name, description FROM categories WHERE id = ?").get(id) });
          return;
        }
        const categoryMatch = url.pathname.match(/^\/api\/admin\/categories\/([^/]+)$/);
        if (categoryMatch && request.method === "PATCH") {
          json(response, 200, { category: updateCategory(decodeURIComponent(categoryMatch[1]), payload) });
          return;
        }
        if (categoryMatch && request.method === "DELETE") {
          const id = decodeURIComponent(categoryMatch[1]);
          const category = db.prepare("SELECT id, name FROM categories WHERE id = ?").get(id);
          if (!category) throw Object.assign(new Error("Category not found."), { status: 404 });
          const usage = db.prepare("SELECT COUNT(*) AS count FROM products WHERE category = ?").get(category.name).count;
          if (usage > 0) throw Object.assign(new Error("Move or delete this category's products before removing it."), { status: 409 });
          db.prepare("DELETE FROM categories WHERE id = ?").run(id);
          json(response, 200, { deleted: true });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/admin/products") {
          json(response, 201, { product: adminProduct(null, payload) });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/admin/blogs") {
          json(response, 201, { post: createBlogPost(payload) });
          return;
        }
        const blogMatch = url.pathname.match(/^\/api\/admin\/blogs\/([^/]+)$/);
        if (blogMatch && request.method === "PUT") {
          json(response, 200, { post: updateBlogPost(decodeURIComponent(blogMatch[1]), payload) });
          return;
        }
        if (blogMatch && request.method === "DELETE") {
          deleteBlogPost(decodeURIComponent(blogMatch[1]));
          json(response, 200, { deleted: true });
          return;
        }
        const productMatch = url.pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
        if (productMatch && request.method === "PUT") {
          json(response, 200, { product: adminProduct(decodeURIComponent(productMatch[1]), payload) });
          return;
        }
        if (productMatch && request.method === "DELETE") {
          const id = decodeURIComponent(productMatch[1]);
          if (!db.prepare("SELECT 1 FROM products WHERE id = ?").get(id)) {
            throw Object.assign(new Error("Product not found."), { status: 404 });
          }
          if (db.prepare("SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1").get(id)) {
            throw Object.assign(new Error("This product is part of an order and cannot be deleted. Set its stock to 0 instead."), { status: 409 });
          }
          db.prepare("DELETE FROM products WHERE id = ?").run(id);
          json(response, 200, { deleted: true });
          return;
        }
        const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
        if (orderMatch && request.method === "PATCH") {
          json(response, 200, { order: updateAdminOrder(decodeURIComponent(orderMatch[1]), payload) });
          return;
        }
        const inquiryMatch = url.pathname.match(/^\/api\/admin\/inquiries\/([^/]+)$/);
        if (inquiryMatch && request.method === "PATCH") {
          json(response, 200, { inquiry: updateInquiry(decodeURIComponent(inquiryMatch[1]), payload) });
          return;
        }
        json(response, 404, { error: "Admin endpoint not found." });
        return;
      }
      if (request.method === "POST" && ["/api/orders", "/api/orders/track", "/api/tracking", "/api/newsletter", "/api/contact"].includes(url.pathname)) {
        if (rateLimited(request, response)) return;
        if (!String(request.headers["content-type"] || "").includes("application/json")) {
          json(response, 415, { error: "Content-Type must be application/json." });
          return;
        }
        const payload = await readJson(request);
        if (url.pathname === "/api/orders") {
          json(response, 201, { order: createOrder(payload) });
          return;
        }
        if (url.pathname === "/api/orders/track") {
          json(response, 200, { order: trackOrder(payload) });
          return;
        }
        if (url.pathname === "/api/tracking") {
          json(response, 200, { order: trackManualOrder(payload.trackingId) });
          return;
        }
        if (url.pathname === "/api/contact") {
          createInquiry(payload);
          json(response, 201, { message: "Thanks for reaching out. Your note is with our team." });
          return;
        }
        const email = cleanText(payload.email, 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          json(response, 400, { error: "Enter a valid email address." });
          return;
        }
        db.prepare("INSERT OR IGNORE INTO newsletter_subscribers (email, created_at) VALUES (?, ?)")
          .run(email, new Date().toISOString());
        json(response, 201, { message: "You're on the list. Look out for a little note from us soon." });
        return;
      }
      json(response, 404, { error: "API endpoint not found." });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        json(response, error.status || 500, { error: error.status ? error.message : "Something went wrong. Please try again." });
      }
      if (!error.status) console.error("API error:", error);
    }
    return;
  }

  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    json(response, 403, { error: "Forbidden." });
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' https://images.unsplash.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"
    });
    response.end(contents);
  });
});

if (require.main === module) {
  server.listen(PORT, process.env.HOST || undefined, () => {
    console.log(`SK Wholesaler is ready at http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_FILE}`);
  });
}

module.exports = {
  createOrder, getProducts, trackOrder, adminDashboard, adminOrders, adminCategories, adminInquiries,
  adminManualOrders, createManualOrder, updateManualOrder, deleteManualOrder, trackManualOrder,
  adminProduct, adminBlogPosts, createAdminSession, createBlogPost, createInquiry, deleteBlogPost, getAdminSession,
  getPublicBlogPost, getPublicBlogPosts, paymentOptions, requireAdmin, updateAdminOrder, updateBlogPost,
  updateCategory, updateInquiry, server, db, migrateLegacyUsdPrices, USD_TO_PKR_RATE,
  FREE_STANDARD_SHIPPING_THRESHOLD, STANDARD_SHIPPING_COST, isRequestSecure
};
