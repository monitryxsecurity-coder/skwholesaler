const adminHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const adminMoney = (paisa) => new Intl.NumberFormat("en-PK", {
  style: "currency",
  currency: "PKR",
  currencyDisplay: "code",
  maximumFractionDigits: 0
}).format(paisa / 100);
let csrfToken = "";
let activePanel = "dashboard";
let cachedCategories = [];
let cachedProducts = [];
const themeStorageKey = "smartcart-admin-theme";

const adminById = (id) => document.getElementById(id);
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = adminById("theme-toggle");
  const dark = theme === "dark";
  toggle.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
  toggle.setAttribute("title", `Switch to ${dark ? "light" : "dark"} theme`);
  toggle.querySelector("span").textContent = dark ? "☀" : "☾";
}

setTheme(localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light");
adminById("theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(themeStorageKey, theme);
  setTheme(theme);
});

const panelCopy = {
  dashboard: ["A little overview", "Your store, <em>at a glance.</em>"],
  orders: ["WhatsApp confirmations", "Manual order <em>tracking.</em>"],
  products: ["The things you offer", "Your product <em>collection.</em>"],
  categories: ["A home for every find", "Your <em>categories.</em>"],
  blogs: ["Your stories, your voice", "The SK Wholesaler <em>journal.</em>"],
  inquiries: ["A person behind every note", "Customer <em>inquiries.</em>"]
};

async function adminApi(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers };
  if (options.method && !["GET", "HEAD"].includes(options.method)) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an unexpected response. Please try again.");
  }
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function setMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error", isError);
}

function setAuthenticated(email) {
  adminById("admin-login-wrap").classList.add("hidden");
  adminById("admin-layout").classList.remove("hidden");
  adminById("admin-email").textContent = email;
  adminById("admin-email").classList.remove("hidden");
  adminById("admin-logout").classList.remove("hidden");
  adminById("admin-date").textContent = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function setSignedOut() {
  csrfToken = "";
  adminById("admin-login-wrap").classList.remove("hidden");
  adminById("admin-layout").classList.add("hidden");
  adminById("admin-email").classList.add("hidden");
  adminById("admin-logout").classList.add("hidden");
}

function inquiryStatusOptions(selected) {
  return ["New", "In progress", "Resolved"]
    .map((status) => `<option ${status === selected ? "selected" : ""}>${status}</option>`).join("");
}

function manualOrderStatusOptions(selected) {
  return ["Confirmed", "Preparing", "Ready for dispatch", "Dispatched", "Delivered", "Cancelled"]
    .map((status) => `<option ${status === selected ? "selected" : ""}>${status}</option>`).join("");
}

function tableMarkup(headers, rows, emptyMessage) {
  return rows.length
    ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<div class="empty-admin">${emptyMessage}</div>`;
}

function renderDashboard(dashboard, orders) {
  const cards = [
    ["Tracked orders", orders.length, "Confirmed through WhatsApp"],
    ["In progress", orders.filter((order) => !["Delivered", "Cancelled"].includes(order.status)).length, "Orders awaiting completion"],
    ["Products", dashboard.productCount, `${dashboard.lowStock} running low`],
    ["New inquiries", dashboard.newInquiries, "Customer notes to review"]
  ];
  const recentOrders = orders.slice(0, 6).map((order) => `
    <tr><td>${adminHtml(order.tracking_id)}<span class="subtext">${new Date(order.created_at).toLocaleDateString()}</span></td>
    <td>${adminHtml(order.customer_name)}<span class="subtext">${adminHtml(order.whatsapp_number)}</span></td>
    <td>${adminHtml(order.status)}</td><td>${adminHtml(order.items_summary)}</td></tr>`);
  adminById("panel-content").innerHTML = `
    <div class="stats-grid">${cards.map(([label, value, note]) => `<article class="stat-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("")}</div>
    <div class="admin-section-head"><div><h2>Recent WhatsApp orders</h2><p>Manually confirmed orders and their customer tracking IDs.</p></div><button data-go-panel="orders">Manage orders ↗</button></div>
    ${tableMarkup(["Tracking ID", "Customer", "Status", "Items"], recentOrders, "No tracked orders yet. Add one after confirming a WhatsApp order.")}`;
}

function renderManualOrders(orders) {
  const rows = orders.map((order) => {
    const digits = order.whatsapp_number.replace(/\D/g, "");
    const whatsappNumber = digits.startsWith("0") ? `92${digits.slice(1)}` : digits;
    const trackingUrl = `${window.location.origin}/tracking.html`;
    const message = `Your SK Wholesaler order is confirmed. Your tracking ID is ${order.tracking_id}. Track it here: ${trackingUrl}`;
    const whatsappLink = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
    return `<tr><td>${adminHtml(order.tracking_id)}<span class="subtext">${new Date(order.created_at).toLocaleString()}</span><a class="small-action" href="${adminHtml(whatsappLink)}" target="_blank" rel="noopener noreferrer">Send ID on WhatsApp ↗</a></td>
      <td>${adminHtml(order.customer_name)}<span class="subtext">${adminHtml(order.whatsapp_number)}</span></td>
      <td>${adminHtml(order.items_summary)}</td>
      <td><div class="order-edit"><label>Status<select data-manual-status="${adminHtml(order.id)}" aria-label="Tracking status for ${adminHtml(order.tracking_id)}">${manualOrderStatusOptions(order.status)}</select></label><textarea data-manual-notes="${adminHtml(order.id)}" aria-label="Private notes for ${adminHtml(order.tracking_id)}" maxlength="1000" placeholder="Private notes">${adminHtml(order.admin_notes)}</textarea><div class="row-actions"><button class="small-action" data-save-manual-order="${adminHtml(order.id)}">Save update</button><button class="small-action danger" data-delete-manual-order="${adminHtml(order.id)}">Delete</button></div></div></td></tr>`;
  });
  adminById("panel-content").innerHTML = `<div class="admin-section-head"><div><h2>WhatsApp order tracker</h2><p>Enter the alphanumeric tracking ID you gave the customer, then set the order status here.</p></div></div>
    <section class="product-edit-panel"><h3>Record a confirmed order</h3><form id="manual-order-form" class="admin-product-form">
      <label>Tracking ID<input name="trackingId" required minlength="6" maxlength="32" pattern="[A-Za-z0-9]{6,32}" autocomplete="off" placeholder="Example: SK7A92B4"><span class="subtext">Use the same ID you sent the customer (6–32 letters or numbers).</span></label>
      <label>Customer name<input name="customerName" required maxlength="100"></label>
      <label>Customer WhatsApp number<input name="whatsappNumber" type="tel" required maxlength="40" placeholder="+92 329 8454735"></label>
      <label class="wide-field">Confirmed order details<textarea name="itemsSummary" required minlength="2" maxlength="2000" rows="3" placeholder="Products, quantities, agreed price, delivery notes"></textarea></label>
      <div class="form-actions"><button type="submit" class="admin-primary">Save tracking record <span>↗</span></button><span class="admin-message" id="manual-order-message"></span></div>
    </form></section>
    ${tableMarkup(["Tracking ID", "Customer", "Order details", "Update customer status"], rows, "No WhatsApp orders recorded yet.")}`;
}

function renderProducts(products, categories) {
  const rows = products.map((product) => `
    <tr><td>${adminHtml(product.name)}<span class="subtext">${adminHtml(product.color)} · ${adminHtml(product.sizes.join(", "))}</span></td>
    <td>${adminHtml(product.category)}</td><td>${adminMoney(product.price_cents)}${product.compare_at_cents ? `<span class="subtext">Was ${adminMoney(product.compare_at_cents)}</span>` : ""}</td>
    <td>${product.stock}${product.stock <= 5 ? `<span class="subtext low-stock">Running low</span>` : ""}</td>
    <td><div class="row-actions"><button class="small-action" data-edit-product="${adminHtml(product.id)}">Edit</button><button class="small-action danger" data-delete-product="${adminHtml(product.id)}">Delete</button></div></td></tr>`);
  const categoryOptions = categories.map((category) => `<option value="${adminHtml(category.name)}"></option>`).join("");
  adminById("panel-content").innerHTML = `
    <div class="admin-section-head"><div><h2>Product inventory</h2><p>Add new finds, adjust details, and keep an eye on available stock.</p></div><button class="admin-primary inline" data-new-product>+ Add a product</button></div>
    <datalist id="product-category-options">${categoryOptions}</datalist>
    <div id="product-editor" class="product-edit-panel hidden"></div>
    ${tableMarkup(["Product", "Category", "Price", "In stock", "Actions"], rows, "No products in the collection.")}`;
}

function productEditor(product = null) {
  const panel = adminById("product-editor");
  const editing = Boolean(product);
  const categoryOptions = cachedCategories.map((category) => `<option value="${adminHtml(category.name)}" ${category.name === product?.category ? "selected" : ""}>${adminHtml(category.name)}</option>`).join("");
  panel.innerHTML = `
    <h3>${editing ? "A few product details" : "Add a new find"}</h3>
    <form class="admin-product-form" id="admin-product-form" data-product-id="${editing ? adminHtml(product.id) : ""}">
      <label>Product name<input name="name" required maxlength="120" value="${editing ? adminHtml(product.name) : ""}"></label>
      <label>Category<select name="category" required>${categoryOptions}</select></label>
      <label>Color / finish<input name="color" required maxlength="80" value="${editing ? adminHtml(product.color) : ""}"></label>
      <label>Price (PKR)<input name="price" type="number" min="0" max="1000000" step="1" required value="${editing ? (product.price_cents / 100).toFixed(0) : ""}"></label>
      <label>Compare-at price (PKR)<input name="compareAt" type="number" min="0" max="1000000" step="1" value="${editing && product.compare_at_cents != null ? (product.compare_at_cents / 100).toFixed(0) : ""}"></label>
      <label>Stock<input name="stock" type="number" min="0" max="1000000" step="1" required value="${editing ? product.stock : "10"}"></label>
      <label class="wide-field">Description<textarea name="description" rows="3" required maxlength="1000">${editing ? adminHtml(product.description) : ""}</textarea></label>
      <label>Image photo ID<input name="image" required maxlength="160" placeholder="photo-123..." value="${editing ? adminHtml(product.image) : ""}"><span class="subtext">Unsplash photo ID, e.g. photo-1434389677669</span></label>
      <label>Sizes / options<input name="sizes" required maxlength="300" value="${editing ? adminHtml(product.sizes.join(", ")) : "One size"}"><span class="subtext">Separate options with commas.</span></label>
      <label>Badge<input name="badge" maxlength="30" placeholder="New, Bestseller..." value="${editing ? adminHtml(product.badge || "") : ""}"></label>
      <div class="form-actions"><button type="submit" class="admin-primary">${editing ? "Save changes" : "Create product"} <span>↗</span></button><button type="button" class="admin-secondary" data-cancel-product>Cancel</button><span class="admin-message" id="product-form-message"></span></div>
    </form>`;
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderCategories(categories) {
  const rows = categories.map((category) => `
    <article class="category-row" data-category-row="${adminHtml(category.id)}">
      <label>Category name<input data-category-name="${adminHtml(category.id)}" maxlength="40" value="${adminHtml(category.name)}"></label>
      <label>Short description<input data-category-description="${adminHtml(category.id)}" maxlength="240" value="${adminHtml(category.description)}"></label>
      <span class="category-count">${category.product_count} products</span>
      <div class="row-actions"><button class="small-action" data-save-category="${adminHtml(category.id)}">Save changes</button><button class="small-action danger" data-delete-category="${adminHtml(category.id)}">Delete</button></div>
    </article>`).join("");
  adminById("panel-content").innerHTML = `
    <div class="admin-section-head"><div><h2>Organize the collection</h2><p>Categories keep your storefront easy to browse. Renaming one updates its products too.</p></div></div>
    <form class="category-create" id="category-create-form"><label>New category<input name="name" required maxlength="40" placeholder="e.g. Objects"></label><label>Short description<input name="description" maxlength="240" placeholder="What belongs here?"></label><button class="admin-primary inline" type="submit">Add category <span>↗</span></button></form>
    <div class="category-list">${rows || `<div class="empty-admin">No categories yet. Add one to start organizing your collection.</div>`}</div>`;
}

function renderInquiries(inquiries) {
  const rows = inquiries.map((inquiry) => `
    <tr><td>${adminHtml(inquiry.full_name)}<span class="subtext"><a href="mailto:${encodeURIComponent(inquiry.email)}">${adminHtml(inquiry.email)}</a></span><span class="subtext">${new Date(inquiry.created_at).toLocaleString()}</span></td>
    <td>${adminHtml(inquiry.subject)}<p class="inquiry-message">${adminHtml(inquiry.message)}</p></td>
    <td><div class="inquiry-edit"><select data-inquiry-status="${adminHtml(inquiry.id)}" aria-label="Inquiry status">${inquiryStatusOptions(inquiry.status)}</select><textarea data-inquiry-notes="${adminHtml(inquiry.id)}" maxlength="1000" placeholder="Private team note">${adminHtml(inquiry.admin_notes)}</textarea><button class="small-action" data-save-inquiry="${adminHtml(inquiry.id)}">Save note</button></div></td></tr>`);
  adminById("panel-content").innerHTML = `<div class="admin-section-head"><div><h2>Customer notes</h2><p>Contact form messages land here so you can keep every conversation in view.</p></div></div>${tableMarkup(["From", "Their message", "Follow-up"], rows, "No customer inquiries yet. New notes will show up here.")}`;
}

function renderBlogs(posts) {
  const rows = posts.map((post) => `
    <tr><td>${adminHtml(post.title)}<span class="subtext">${adminHtml(post.slug)}</span></td>
    <td>${adminHtml(post.status)}<span class="subtext">${post.published_at ? `Published ${new Date(post.published_at).toLocaleDateString()}` : "Not visible on the storefront"}</span></td>
    <td>${adminHtml(post.author)}</td>
    <td><div class="row-actions"><button class="small-action" data-edit-blog="${adminHtml(post.id)}">Edit</button><button class="small-action danger" data-delete-blog="${adminHtml(post.id)}">Delete</button></div></td></tr>`);
  adminById("panel-content").innerHTML = `
    <div class="admin-section-head"><div><h2>Journal stories</h2><p>Write, edit, publish, and unpublish stories shown on the storefront.</p></div><button class="admin-primary inline" data-new-blog>+ Write a story</button></div>
    <div id="blog-editor" class="product-edit-panel hidden"></div>
    ${tableMarkup(["Story", "Status", "Author", "Actions"], rows, "No journal stories yet. Write the first one.")}`;
}

function blogEditor(post = null) {
  const panel = adminById("blog-editor");
  const editing = Boolean(post);
  panel.innerHTML = `
    <h3>${editing ? "Edit this story" : "Write a new story"}</h3>
    <form class="admin-product-form blog-editor-form" id="admin-blog-form" data-blog-id="${editing ? adminHtml(post.id) : ""}">
      <label class="wide-field">Title<input name="title" required maxlength="160" value="${editing ? adminHtml(post.title) : ""}"></label>
      <label>Author<input name="author" required maxlength="100" value="${editing ? adminHtml(post.author) : "SK Wholesaler"}"></label>
      <label>Status<select name="status"><option ${!editing || post.status === "Draft" ? "selected" : ""}>Draft</option><option ${editing && post.status === "Published" ? "selected" : ""}>Published</option></select></label>
      <label class="wide-field">Short introduction<textarea name="excerpt" rows="2" required maxlength="320">${editing ? adminHtml(post.excerpt) : ""}</textarea></label>
      <label>Cover image photo ID<input name="image" required maxlength="160" placeholder="photo-1434389677669..." value="${editing ? adminHtml(post.image) : ""}"><span class="subtext">Use an Unsplash photo ID.</span></label>
      <label class="wide-field">Story<textarea name="content" rows="10" required minlength="20" maxlength="15000" placeholder="Write the story. Leave a blank line between paragraphs.">${editing ? adminHtml(post.content) : ""}</textarea><span class="subtext">Plain text only. Put a blank line between paragraphs.</span></label>
      <div class="form-actions"><button type="submit" class="admin-primary">${editing ? "Save story" : "Create story"} <span>↗</span></button><button type="button" class="admin-secondary" data-cancel-blog>Cancel</button><span class="admin-message" id="blog-form-message"></span></div>
    </form>`;
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadPanel(panel = activePanel) {
  activePanel = panel;
  document.querySelectorAll(".admin-nav").forEach((button) => button.classList.toggle("active", button.dataset.panel === panel));
  const [eyebrow, title] = panelCopy[panel];
  adminById("panel-eyebrow").textContent = eyebrow;
  adminById("panel-title").innerHTML = title;
  setMessage(adminById("admin-message"), "");
  const content = adminById("panel-content");
  content.innerHTML = `<div class="empty-admin">Gathering the store details…</div>`;
  try {
    if (panel === "dashboard") {
      const [dashboard, orderData] = await Promise.all([
        adminApi("/api/admin/dashboard"),
        adminApi("/api/admin/manual-orders")
      ]);
      renderDashboard(dashboard.dashboard, orderData.orders);
      adminById("inquiry-badge").textContent = dashboard.dashboard.newInquiries || "";
    } else if (panel === "orders") {
      const result = await adminApi("/api/admin/manual-orders");
      renderManualOrders(result.orders);
    } else if (panel === "products") {
      const [products, categories] = await Promise.all([
        adminApi("/api/admin/products"), adminApi("/api/admin/categories")
      ]);
      cachedProducts = products.products;
      cachedCategories = categories.categories;
      renderProducts(cachedProducts, cachedCategories);
    } else if (panel === "categories") {
      const result = await adminApi("/api/admin/categories");
      cachedCategories = result.categories;
      renderCategories(cachedCategories);
    } else if (panel === "inquiries") {
      const result = await adminApi("/api/admin/inquiries");
      renderInquiries(result.inquiries);
    } else if (panel === "blogs") {
      const result = await adminApi("/api/admin/blogs");
      renderBlogs(result.posts);
    }
  } catch (error) {
    if (error.message.includes("Please sign in")) {
      setSignedOut();
      return;
    }
    content.innerHTML = `<div class="empty-admin">${adminHtml(error.message)}</div>`;
  }
}

function moneyToCents(value, optional = false) {
  if (optional && value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : NaN;
}

adminById("admin-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = adminById("login-button");
  const message = adminById("login-message");
  const values = Object.fromEntries(new FormData(form).entries());
  setMessage(message, "Checking your sign-in…");
  button.disabled = true;
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(values)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Sign-in failed.");
    csrfToken = result.csrfToken;
    setAuthenticated(result.email);
    form.reset();
    await loadPanel("dashboard");
  } catch (error) {
    setMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

adminById("admin-logout").addEventListener("click", async () => {
  try {
    await adminApi("/api/admin/logout", { method: "POST", body: "{}" });
    setSignedOut();
    setMessage(adminById("login-message"), "You are signed out.");
  } catch (error) {
    setMessage(adminById("admin-message"), error.message, true);
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const panelButton = target.closest("[data-panel], [data-go-panel]");
  if (panelButton) {
    await loadPanel(panelButton.dataset.panel || panelButton.dataset.goPanel);
    return;
  }
  if (target.closest("[data-new-product]")) {
    if (!cachedCategories.length) {
      setMessage(adminById("admin-message"), "Add a category before creating products.", true);
      return;
    }
    productEditor();
  }
  if (target.closest("[data-new-blog]")) blogEditor();
  if (target.closest("[data-cancel-blog]")) adminById("blog-editor").classList.add("hidden");
  const editBlog = target.closest("[data-edit-blog]");
  if (editBlog) {
    try {
      const result = await adminApi("/api/admin/blogs");
      const post = result.posts.find((item) => item.id === editBlog.dataset.editBlog);
      if (post) blogEditor(post);
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
  const deleteBlog = target.closest("[data-delete-blog]");
  if (deleteBlog && window.confirm("Delete this journal story?")) {
    try {
      await adminApi(`/api/admin/blogs/${encodeURIComponent(deleteBlog.dataset.deleteBlog)}`, { method: "DELETE" });
      await loadPanel("blogs");
      setMessage(adminById("admin-message"), "Story deleted.");
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
  if (target.closest("[data-cancel-product]")) adminById("product-editor").classList.add("hidden");
  const editProduct = target.closest("[data-edit-product]");
  if (editProduct) {
    const product = cachedProducts.find((item) => item.id === editProduct.dataset.editProduct);
    if (product) productEditor(product);
  }
  const deleteProduct = target.closest("[data-delete-product]");
  if (deleteProduct && window.confirm("Delete this product? Products already included in orders cannot be deleted.")) {
    try {
      await adminApi(`/api/admin/products/${encodeURIComponent(deleteProduct.dataset.deleteProduct)}`, { method: "DELETE" });
      await loadPanel("products");
      setMessage(adminById("admin-message"), "Product deleted.");
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
  const saveManualOrder = target.closest("[data-save-manual-order]");
  if (saveManualOrder) {
    const id = saveManualOrder.dataset.saveManualOrder;
    try {
      const result = await adminApi(`/api/admin/manual-orders/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: document.querySelector(`[data-manual-status="${CSS.escape(id)}"]`).value,
          adminNotes: document.querySelector(`[data-manual-notes="${CSS.escape(id)}"]`).value
        })
      });
      await loadPanel("orders");
      setMessage(adminById("admin-message"), `Tracking record ${result.order.tracking_id} updated.`);
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
  const deleteManualOrder = target.closest("[data-delete-manual-order]");
  if (deleteManualOrder && window.confirm("Delete this tracking record? The customer will no longer be able to look it up.")) {
    try {
      await adminApi(`/api/admin/manual-orders/${encodeURIComponent(deleteManualOrder.dataset.deleteManualOrder)}`, { method: "DELETE" });
      await loadPanel("orders");
      setMessage(adminById("admin-message"), "Tracking record deleted.");
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
  const saveCategory = target.closest("[data-save-category]");
  if (saveCategory) {
    const id = saveCategory.dataset.saveCategory;
    try {
      await adminApi(`/api/admin/categories/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: document.querySelector(`[data-category-name="${CSS.escape(id)}"]`).value,
          description: document.querySelector(`[data-category-description="${CSS.escape(id)}"]`).value
        })
      });
      await loadPanel("categories");
      setMessage(adminById("admin-message"), "Category and its products updated.");
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
  const deleteCategory = target.closest("[data-delete-category]");
  if (deleteCategory && window.confirm("Delete this category? It must not contain products.")) {
    try {
      await adminApi(`/api/admin/categories/${encodeURIComponent(deleteCategory.dataset.deleteCategory)}`, { method: "DELETE" });
      await loadPanel("categories");
      setMessage(adminById("admin-message"), "Category deleted.");
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
  const saveInquiry = target.closest("[data-save-inquiry]");
  if (saveInquiry) {
    const id = saveInquiry.dataset.saveInquiry;
    try {
      await adminApi(`/api/admin/inquiries/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: document.querySelector(`[data-inquiry-status="${CSS.escape(id)}"]`).value,
          adminNotes: document.querySelector(`[data-inquiry-notes="${CSS.escape(id)}"]`).value
        })
      });
      await loadPanel("inquiries");
      setMessage(adminById("admin-message"), "Inquiry updated.");
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id === "admin-product-form") {
    event.preventDefault();
    const values = new FormData(form);
    const product = {
      name: values.get("name"),
      category: values.get("category"),
      color: values.get("color"),
      priceCents: moneyToCents(values.get("price")),
      compareAtCents: moneyToCents(values.get("compareAt"), true),
      stock: Number(values.get("stock")),
      description: values.get("description"),
      image: values.get("image"),
      sizes: values.get("sizes").split(",").map((size) => size.trim()).filter(Boolean),
      badge: values.get("badge")
    };
    const message = adminById("product-form-message");
    try {
      const id = form.dataset.productId;
      await adminApi(id ? `/api/admin/products/${encodeURIComponent(id)}` : "/api/admin/products", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(product)
      });
      await loadPanel("products");
      setMessage(adminById("admin-message"), id ? "Product changes saved." : "Product added to your collection.");
    } catch (error) {
      setMessage(message, error.message, true);
    }
  }
  if (form.id === "category-create-form") {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await adminApi("/api/admin/categories", { method: "POST", body: JSON.stringify(values) });
      await loadPanel("categories");
      setMessage(adminById("admin-message"), "Category added.");
    } catch (error) {
      setMessage(adminById("admin-message"), error.message, true);
    }
  }
  if (form.id === "manual-order-form") {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const message = adminById("manual-order-message");
    try {
      const result = await adminApi("/api/admin/manual-orders", { method: "POST", body: JSON.stringify(values) });
      await loadPanel("orders");
      setMessage(adminById("admin-message"), `Tracking ID ${result.order.tracking_id} saved. Send its status to the customer using the WhatsApp link.`);
    } catch (error) {
      setMessage(message, error.message, true);
    }
  }
  if (form.id === "admin-blog-form") {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const message = adminById("blog-form-message");
    try {
      const id = form.dataset.blogId;
      await adminApi(id ? `/api/admin/blogs/${encodeURIComponent(id)}` : "/api/admin/blogs", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(values)
      });
      await loadPanel("blogs");
      setMessage(adminById("admin-message"), id ? "Journal story updated." : "Journal story created.");
    } catch (error) {
      setMessage(message, error.message, true);
    }
  }
});

async function restoreAdminSession() {
  try {
    const result = await fetch("/api/admin/session", { credentials: "same-origin" }).then((response) => response.json());
    if (!result.authenticated) return;
    csrfToken = result.csrfToken;
    setAuthenticated(result.email);
    await loadPanel("dashboard");
  } catch (error) {
    setMessage(adminById("login-message"), error.message, true);
  }
}

restoreAdminSession();
