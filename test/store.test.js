const { after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcart-test-"));
process.env.DB_PATH = path.join(tempDir, "store.sqlite");
process.env.SMARTCART_ADMIN_EMAIL = "admin@example.test";
process.env.SMARTCART_ADMIN_PASSWORD = "smartcart-test-password";
process.env.SMARTCART_PAYMENT_RECIPIENT_NAME = "Yasir Zulfiqar";
process.env.SMARTCART_PAYMENT_RECIPIENT_NUMBER = "03267217749";
const {
  adminCategories, adminDashboard, adminInquiries, adminProduct, adminBlogPosts, createAdminSession, createBlogPost,
  adminManualOrders, createInquiry, createManualOrder, createOrder, deleteBlogPost, deleteManualOrder, getAdminSession,
  getProducts, getPublicBlogPost, getPublicBlogPosts, paymentOptions, requireAdmin, trackManualOrder, trackOrder,
  updateAdminOrder, updateBlogPost, updateCategory, updateInquiry, updateManualOrder, isRequestSecure, db
} = require("../server");
const { migrateLegacyUsdPrices, FREE_STANDARD_SHIPPING_THRESHOLD, STANDARD_SHIPPING_COST, USD_TO_PKR_RATE } = require("../server");

beforeEach(() => {
  db.exec("DELETE FROM manual_orders;");
  db.exec("DELETE FROM order_items; DELETE FROM orders;");
  db.prepare("DELETE FROM inquiries").run();
  db.prepare("UPDATE products SET stock = 18 WHERE id = 'arc-knit'").run();
});

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function sampleOrder(items = [{ productId: "arc-knit", size: "S", quantity: 1 }], shippingMethod = "standard") {
  return createOrder({
    customer: {
      fullName: "Sample Customer",
      email: "sample@example.com",
      address: "12 Example Road",
      city: "Portland",
      postalCode: "97201",
      country: "United States",
      phone: "555-0100"
    },
    shippingMethod,
    paymentMethod: "cod",
    items
  });
}

function responseRecorder() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); }
  };
}

test("seeds products and filters by category", () => {
  const allProducts = getProducts(new URL("http://localhost/api/products"));
  const clothing = getProducts(new URL("http://localhost/api/products?category=Clothing"));
  const electronics = getProducts(new URL("http://localhost/api/products?category=Electronics"));
  assert.equal(allProducts.length, 21);
  assert.equal(db.prepare("SELECT price_cents FROM products WHERE id = 'arc-knit'").get().price_cents, 12800 * USD_TO_PKR_RATE);
  assert.ok(clothing.length > 0);
  assert.ok(clothing.every((product) => product.category === "Clothing"));
  assert.equal(electronics.length, 3);
});

test("legacy USD prices and orders migrate to PKR exactly once", () => {
  const legacyDb = new DatabaseSync(path.join(tempDir, "legacy.sqlite"));
  legacyDb.exec(`
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE products (price_cents INTEGER NOT NULL, compare_at_cents INTEGER);
    CREATE TABLE orders (subtotal_cents INTEGER, shipping_cents INTEGER, tax_cents INTEGER, total_cents INTEGER);
    CREATE TABLE order_items (unit_price_cents INTEGER);
    INSERT INTO products VALUES (1000, 1200);
    INSERT INTO orders VALUES (10000, 800, 864, 11664);
    INSERT INTO order_items VALUES (1000);
  `);
  try {
    assert.equal(migrateLegacyUsdPrices(legacyDb), true);
    const migratedProduct = legacyDb.prepare("SELECT price_cents, compare_at_cents FROM products").get();
    assert.equal(migratedProduct.price_cents, 1000 * USD_TO_PKR_RATE);
    assert.equal(migratedProduct.compare_at_cents, 1200 * USD_TO_PKR_RATE);
    const migratedOrder = legacyDb.prepare("SELECT subtotal_cents, shipping_cents, tax_cents, total_cents FROM orders").get();
    assert.equal(migratedOrder.subtotal_cents, 10000 * USD_TO_PKR_RATE);
    assert.equal(migratedOrder.shipping_cents, 800 * USD_TO_PKR_RATE);
    assert.equal(migratedOrder.tax_cents, 864 * USD_TO_PKR_RATE);
    assert.equal(migratedOrder.total_cents, 11664 * USD_TO_PKR_RATE);
    assert.equal(legacyDb.prepare("SELECT unit_price_cents FROM order_items").get().unit_price_cents, 1000 * USD_TO_PKR_RATE);
    assert.equal(migrateLegacyUsdPrices(legacyDb), false);
    assert.equal(legacyDb.prepare("SELECT price_cents FROM products").get().price_cents, 1000 * USD_TO_PKR_RATE);
  } finally {
    legacyDb.close();
  }
  assert.equal(STANDARD_SHIPPING_COST, 224000);
  assert.equal(FREE_STANDARD_SHIPPING_THRESHOLD, 4200000);
});

test("calculates totals from stored prices and updates inventory atomically", () => {
  const before = db.prepare("SELECT stock FROM products WHERE id = 'arc-knit'").get().stock;
  const order = sampleOrder();
  assert.equal(order.status, "Pending");
  assert.equal(order.totalCents, order.subtotalCents + order.shippingCents + order.taxCents);
  assert.equal(order.shippingCents, STANDARD_SHIPPING_COST);
  assert.equal(db.prepare("SELECT stock FROM products WHERE id = 'arc-knit'").get().stock, before - 1);
});

test("orders progress from Pending through Delivered or can be cancelled while Delivering", () => {
  const deliveredOrder = sampleOrder();
  const deliveredOrderId = db.prepare("SELECT id FROM orders WHERE order_number = ?").get(deliveredOrder.orderNumber).id;
  assert.equal(deliveredOrder.status, "Pending");
  assert.equal(updateAdminOrder(deliveredOrderId, { status: "Processing" }).status, "Processing");
  assert.equal(updateAdminOrder(deliveredOrderId, { status: "Delivering" }).status, "Delivering");
  assert.equal(updateAdminOrder(deliveredOrderId, { status: "Delivered" }).status, "Delivered");
  assert.throws(() => updateAdminOrder(deliveredOrderId, { status: "Cancelled" }), /status change is not allowed/);

  const cancelledOrder = sampleOrder();
  const cancelledOrderId = db.prepare("SELECT id FROM orders WHERE order_number = ?").get(cancelledOrder.orderNumber).id;
  updateAdminOrder(cancelledOrderId, { status: "Processing" });
  updateAdminOrder(cancelledOrderId, { status: "Delivering" });
  assert.equal(updateAdminOrder(cancelledOrderId, { status: "Cancelled" }).status, "Cancelled");
});

test("dashboard sales graph returns 14 days and excludes cancelled orders", () => {
  const order = sampleOrder();
  const today = new Date().toISOString().slice(0, 10);
  const dashboard = adminDashboard();
  assert.equal(dashboard.sales.length, 14);
  assert.deepEqual(dashboard.sales.at(-1), {
    day: today,
    salesCents: order.totalCents,
    orderCount: 1
  });

  const orderId = db.prepare("SELECT id FROM orders WHERE order_number = ?").get(order.orderNumber).id;
  updateAdminOrder(orderId, { status: "Cancelled" });
  assert.equal(adminDashboard().sales.at(-1).salesCents, 0);
  assert.equal(adminDashboard().sales.at(-1).orderCount, 0);
});

test("provides cash, JazzCash, and bank transfer with unverified manual payment details", () => {
  const methods = paymentOptions();
  assert.deepEqual(methods.methods.map((method) => method.id), ["cod", "jazzcash", "bank-transfer"]);
  assert.deepEqual(methods.recipient, { name: "Yasir Zulfiqar", number: "03267217749" });
  assert.equal(methods.paymentProofWhatsAppNumber, "03147415741");
  const jazzcash = createOrder({
    customer: {
      fullName: "Sample Customer", email: "sample@example.com", address: "12 Example Road",
      city: "Portland", postalCode: "97201", country: "United States", phone: "555-0100"
    },
    paymentMethod: "jazzcash",
    items: [{ productId: "arc-knit", size: "S", quantity: 1 }]
  });
  assert.equal(jazzcash.paymentStatus, "Unverified");
  assert.equal(jazzcash.status, "Pending");
  assert.equal(jazzcash.paymentProofWhatsAppNumber, "03147415741");
  assert.match(jazzcash.paymentInstructions, /PKR/);
  assert.match(jazzcash.paymentInstructions, /03267217749/);
  assert.match(jazzcash.paymentInstructions, /Yasir Zulfiqar/);
  const jazzcashOrderId = db.prepare("SELECT id FROM orders WHERE order_number = ?").get(jazzcash.orderNumber).id;
  assert.equal(updateAdminOrder(jazzcashOrderId, { status: "Processing", paymentStatus: "Paid" }).payment_status, "Paid");
  assert.throws(() => updateAdminOrder(jazzcashOrderId, { status: "Cancelled" }), /refunded before cancelling/);
  assert.equal(updateAdminOrder(jazzcashOrderId, { status: "Cancelled", paymentStatus: "Refunded" }).payment_status, "Refunded");
  assert.throws(() => updateAdminOrder(jazzcashOrderId, { status: "Cancelled", paymentStatus: "Paid" }), /cannot be changed after an order is cancelled/);
  const bankTransfer = createOrder({
    customer: {
      fullName: "Sample Customer", email: "sample@example.com", address: "12 Example Road",
      city: "Portland", postalCode: "97201", country: "United States", phone: "555-0100"
    },
    paymentMethod: "bank-transfer",
    items: [{ productId: "arc-knit", size: "S", quantity: 1 }]
  });
  assert.equal(bankTransfer.paymentStatus, "Unverified");
  assert.match(bankTransfer.paymentInstructions, /bank's supported transfer service/);
  const bankOrderId = db.prepare("SELECT id FROM orders WHERE order_number = ?").get(bankTransfer.orderNumber).id;
  updateAdminOrder(bankOrderId, { status: "Processing" });
  assert.throws(() => updateAdminOrder(bankOrderId, { status: "Delivering" }), /Verify the manual payment/);
  updateAdminOrder(bankOrderId, { status: "Delivering", paymentStatus: "Paid" });
  assert.equal(db.prepare("SELECT status FROM orders WHERE id = ?").get(bankOrderId).status, "Delivering");
  assert.equal(updateAdminOrder(bankOrderId, { status: "Delivered" }).status, "Delivered");
  for (const paymentMethod of ["unknown", "toString"]) {
    assert.throws(() => createOrder({
      customer: {
        fullName: "Sample Customer", email: "sample@example.com", address: "12 Example Road",
        city: "Portland", postalCode: "97201", country: "United States", phone: "555-0100"
      },
      paymentMethod,
      items: [{ productId: "arc-knit", size: "S", quantity: 1 }]
    }), /Choose cash on delivery/);
  }
});

test("uses standard shipping without a customer delivery-method choice", () => {
  const items = [{ productId: "arc-knit", size: "S", quantity: 2 }];
  const standard = sampleOrder(items);
  assert.equal(standard.shippingMethod, "Standard shipping");
  assert.equal(standard.shippingCents, 0);
  db.prepare("UPDATE products SET stock = 18 WHERE id = 'arc-knit'").run();
  const belowFreeShipping = sampleOrder([{ productId: "arc-knit", size: "S", quantity: 1 }], "express");
  assert.equal(belowFreeShipping.shippingMethod, "Standard shipping");
  assert.equal(belowFreeShipping.shippingCents, STANDARD_SHIPPING_COST);
});

test("rejects unavailable inventory without creating a partial order", () => {
  db.prepare("UPDATE products SET stock = 2 WHERE id = 'arc-knit'").run();
  assert.throws(() => sampleOrder([{ productId: "arc-knit", size: "S", quantity: 3 }]), /not have enough stock/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
  assert.equal(db.prepare("SELECT stock FROM products WHERE id = 'arc-knit'").get().stock, 2);
});

test("reveals order details only when both order number and email match", () => {
  const created = sampleOrder();
  const matching = trackOrder({ orderNumber: created.orderNumber, email: created.email });
  assert.equal(matching.order_number, created.orderNumber);
  assert.equal(matching.items.length, 1);
  assert.throws(
    () => trackOrder({ orderNumber: created.orderNumber, email: "other@example.com" }),
    /couldn't find an order/
  );
});

test("creates manual WhatsApp orders with generated IDs and supports customer tracking updates", () => {
  const created = createManualOrder({
    customerName: "WhatsApp Customer",
    whatsappNumber: "+92 329 8454735",
    itemsSummary: "Arc Knit Cardigan × 2 — PKR 25,600"
  });
  assert.match(created.tracking_id, /^[A-F0-9]{20}$/);
  assert.equal(created.status, "Confirmed");
  assert.equal(adminManualOrders().length, 1);
  assert.equal(trackManualOrder(created.tracking_id).items_summary, "Arc Knit Cardigan × 2 — PKR 25,600");
  assert.equal("whatsapp_number" in trackManualOrder(created.tracking_id), false);

  const updated = updateManualOrder(created.id, { status: "Dispatched", adminNotes: "Courier pickup arranged." });
  assert.equal(updated.status, "Dispatched");
  assert.equal(updated.admin_notes, "Courier pickup arranged.");
  assert.equal(trackManualOrder(created.tracking_id.toLowerCase()).status, "Dispatched");

  deleteManualOrder(created.id);
  assert.equal(adminManualOrders().length, 0);
  assert.throws(() => trackManualOrder(created.tracking_id), /couldn't find a tracking record/);
});

test("saves the exact customer-provided tracking ID and rejects duplicate IDs", () => {
  const record = createManualOrder({
    trackingId: "sk7A92B4",
    customerName: "WhatsApp Customer",
    whatsappNumber: "03298454735",
    itemsSummary: "Confirmed WhatsApp order"
  });
  assert.equal(record.tracking_id, "SK7A92B4");
  assert.equal(trackManualOrder("sk7a92b4").tracking_id, "SK7A92B4");
  assert.throws(() => createManualOrder({
    trackingId: "SK7A92B4",
    customerName: "Another Customer",
    whatsappNumber: "03298454736",
    itemsSummary: "Another order"
  }), /already in use/);
});

test("validates manual WhatsApp order details and tracking statuses", () => {
  assert.throws(() => createManualOrder({
    customerName: "Customer",
    whatsappNumber: "not a phone",
    itemsSummary: "Order items"
  }), /valid WhatsApp number/);
  assert.throws(() => createManualOrder({
    trackingId: "ID-123",
    customerName: "WhatsApp Customer",
    whatsappNumber: "03298454735",
    itemsSummary: "Order items"
  }), /alphanumeric tracking ID/);
  const created = createManualOrder({
    customerName: "WhatsApp Customer",
    whatsappNumber: "03298454735",
    itemsSummary: "Order items"
  });
  assert.throws(() => updateManualOrder(created.id, { status: "Paid" }), /valid tracking status/);
  assert.throws(() => trackManualOrder("bad-id"), /alphanumeric tracking ID/);
});

test("protects admin routes and requires a valid CSRF token for changes", () => {
  const denied = responseRecorder();
  assert.equal(requireAdmin({ method: "GET", headers: {}, socket: { encrypted: false } }, denied, null), false);
  assert.equal(denied.status, 401);

  const adminSession = createAdminSession(process.env.SMARTCART_ADMIN_EMAIL);
  const request = { headers: { cookie: `smartcart_admin=${adminSession.token}` } };
  const session = getAdminSession(request);
  assert.equal(session.email, process.env.SMARTCART_ADMIN_EMAIL);

  const csrfDenied = responseRecorder();
  assert.equal(requireAdmin({ method: "POST", headers: {}, socket: { encrypted: false } }, csrfDenied, session), false);
  assert.equal(csrfDenied.status, 403);
  assert.equal(requireAdmin({
    method: "POST",
    headers: { "x-csrf-token": adminSession.csrfToken },
    socket: { encrypted: false }
  }, responseRecorder(), session), true);
});

test("trusts forwarded HTTPS only when explicitly enabled for a reverse proxy", () => {
  const request = {
    headers: { "x-forwarded-proto": "https" },
    socket: { encrypted: false }
  };
  const originalTrustProxy = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(isRequestSecure(request), false);
    process.env.TRUST_PROXY = "true";
    assert.equal(isRequestSecure(request), true);
    request.headers["x-forwarded-proto"] = "http";
    assert.equal(isRequestSecure(request), false);
  } finally {
    if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrustProxy;
  }
});

test("admin can manage categories and products without breaking storefront categories", () => {
  const categoryId = `test-category-${Date.now()}`;
  db.prepare("INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?)")
    .run(categoryId, "Test Objects", new Date().toISOString());
  const product = adminProduct(null, {
    name: "Admin Test Product",
    category: "Test Objects",
    description: "A product created by the admin test suite.",
    priceCents: 2500,
    compareAtCents: null,
    image: "photo-1434389677669-e08b4cac3105",
    color: "Sand",
    sizes: ["One size"],
    badge: "New",
    stock: 5
  });
  assert.equal(product.price_cents, 2500);
  const updatedCategory = updateCategory(categoryId, { name: "Test Home", description: "Updated category" });
  assert.equal(updatedCategory.name, "Test Home");
  assert.equal(db.prepare("SELECT category FROM products WHERE id = ?").get(product.id).category, "Test Home");
  assert.ok(getProducts(new URL("http://localhost/api/products?category=Test%20Home")).some((item) => item.id === product.id));
  assert.equal(adminCategories().find((category) => category.id === categoryId).product_count, 1);
});

test("contact messages appear in admin inquiries and can be resolved", () => {
  const inquiry = createInquiry({
    fullName: "Curious Customer",
    email: "customer@example.com",
    subject: "A product question",
    message: "Could you tell me more about this item?"
  });
  assert.equal(adminInquiries().length, 1);
  const resolved = updateInquiry(inquiry.id, { status: "Resolved", adminNotes: "Replied to customer." });
  assert.equal(resolved.status, "Resolved");
  assert.equal(resolved.admin_notes, "Replied to customer.");
  assert.equal(adminDashboard().newInquiries, 0);
});

test("admin can draft, publish, edit, and remove journal stories", () => {
  const draft = createBlogPost({
    title: "A test story",
    excerpt: "An introduction to a story managed in admin.",
    content: "This is the body of our test story, which is long enough to pass validation.",
    image: "photo-1434389677669-e08b4cac3105",
    author: "SmartCart",
    status: "Draft"
  });
  assert.equal(getPublicBlogPosts().some((post) => post.slug === draft.slug), false);
  const published = updateBlogPost(draft.id, {
    title: "A published test story",
    excerpt: "An updated introduction to a published story.",
    content: "This is the updated body of our test story, published for the storefront.",
    image: "photo-1434389677669-e08b4cac3105",
    author: "SmartCart",
    status: "Published"
  });
  assert.ok(published.published_at);
  assert.equal(getPublicBlogPost(published.slug).title, "A published test story");
  assert.ok(adminBlogPosts().some((post) => post.id === draft.id));
  deleteBlogPost(draft.id);
  assert.equal(adminBlogPosts().some((post) => post.id === draft.id), false);
});

test("admin cancellation restores inventory exactly once", () => {
  const order = sampleOrder();
  assert.equal(db.prepare("SELECT stock FROM products WHERE id = 'arc-knit'").get().stock, 17);
  const orderId = db.prepare("SELECT id FROM orders WHERE order_number = ?").get(order.orderNumber).id;
  updateAdminOrder(orderId, { status: "Cancelled", adminNotes: "Customer requested cancellation." });
  assert.equal(db.prepare("SELECT stock FROM products WHERE id = 'arc-knit'").get().stock, 18);
  updateAdminOrder(orderId, { status: "Cancelled", adminNotes: "" });
  assert.equal(db.prepare("SELECT stock FROM products WHERE id = 'arc-knit'").get().stock, 18);
  assert.throws(() => updateAdminOrder(orderId, { status: "Processing" }), /status change is not allowed/);
  assert.equal(db.prepare("SELECT stock FROM products WHERE id = 'arc-knit'").get().stock, 18);
  assert.equal(adminDashboard().grossSalesCents, 0);
});
