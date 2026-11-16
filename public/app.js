const money = (paisa) => new Intl.NumberFormat("en-PK", {
  style: "currency",
  currency: "PKR",
  currencyDisplay: "code",
  maximumFractionDigits: 0
}).format(paisa / 100);
const imageUrl = (image, width = 900) => `https://images.unsplash.com/${encodeURIComponent(image)}?auto=format&fit=crop&w=${width}&q=85`;
const WHATSAPP_NUMBER = "923298454735";
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const readStored = (key) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const state = {
  products: [],
  category: "All",
  query: "",
  sort: "featured",
  cart: readStored("smartcart-cart"),
  wishlist: readStored("smartcart-wishlist"),
  openProductId: null
};
const byId = (id) => document.getElementById(id);
const grid = byId("product-grid");
const overlay = byId("overlay");
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an unexpected response. Please try again.");
  }
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function persist() {
  localStorage.setItem("smartcart-cart", JSON.stringify(state.cart));
  localStorage.setItem("smartcart-wishlist", JSON.stringify(state.wishlist));
  updateCounts();
}

function announce(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function updateCounts() {
  byId("cart-count").textContent = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  byId("wishlist-count").textContent = state.wishlist.length;
  byId("drawer-cart-count").textContent = `(${state.cart.reduce((sum, item) => sum + item.quantity, 0)})`;
}

async function loadBlogPreview() {
  const container = byId("journal-preview-grid");
  try {
    const result = await api("/api/blogs");
    container.innerHTML = result.posts.slice(0, 3).map((post) => `
      <a class="journal-card" href="/blog-post.html?slug=${encodeURIComponent(post.slug)}">
        <img src="${imageUrl(post.image, 700)}" alt="" loading="lazy">
        <span class="journal-card-date">${new Date(post.published_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
        <h3>${escapeHtml(post.title)}</h3><p>${escapeHtml(post.excerpt)}</p><span class="journal-card-link">Read the story ↗</span>
      </a>`).join("");
    if (!result.posts.length) container.innerHTML = `<p class="journal-empty">No blog posts yet. <a href="/blog.html">View the blog</a></p>`;
  } catch (error) {
    container.innerHTML = `<p class="journal-empty">The blog could not load. <a href="/blog.html">Try again ↗</a> <span>${escapeHtml(error.message)}</span></p>`;
  }
}

function filteredProducts() {
  const query = state.query.toLowerCase();
  let products = state.products.filter((product) => {
    const matchesCategory = state.category === "All" || product.category === state.category;
    const matchesQuery = !query || `${product.name} ${product.description} ${product.category} ${product.color}`.toLowerCase().includes(query);
    return matchesCategory && matchesQuery;
  });
  if (state.sort === "price-low") products = [...products].sort((a, b) => a.price_cents - b.price_cents);
  if (state.sort === "price-high") products = [...products].sort((a, b) => b.price_cents - a.price_cents);
  if (state.sort === "top-rated") products = [...products].sort((a, b) => b.rating - a.rating);
  return products;
}

function renderProducts() {
  const products = filteredProducts();
  byId("result-count").textContent = `${products.length} ${products.length === 1 ? "product" : "products"}`;
  byId("products-heading").innerHTML = state.category === "All"
    ? "All <em>products</em>"
    : `${escapeHtml(state.category)} <em>products</em>`;
  grid.innerHTML = products.map((product) => `
    <article class="product-card">
      <button class="product-image-button" data-product="${escapeHtml(product.id)}" aria-label="View ${escapeHtml(product.name)}">
        <img src="${imageUrl(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy">
        ${product.badge ? `<span class="product-badge">${escapeHtml(product.badge)}</span>` : ""}
      </button>
      <button class="heart-button ${state.wishlist.includes(product.id) ? "is-saved" : ""}" data-heart="${escapeHtml(product.id)}" aria-label="${state.wishlist.includes(product.id) ? "Remove from" : "Add to"} wishlist">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.7c0 5.1-8.8 10-8.8 10s-8.8-4.9-8.8-10a4.7 4.7 0 0 1 8.8-2.2 4.7 4.7 0 0 1 8.8 2.2Z"></path></svg>
      </button>
      <div class="product-card-info"><div><button class="product-name" data-product="${escapeHtml(product.id)}">${escapeHtml(product.name)}</button><span class="product-color">${escapeHtml(product.color)}</span></div>
        <div class="product-price">${money(product.price_cents)}${product.compare_at_cents ? `<del>${money(product.compare_at_cents)}</del>` : ""}</div></div>
      <div class="rating"><span>★</span> ${Number(product.rating).toFixed(1)} <span class="rating-count">(${product.reviews} reviews)</span></div>
      <div class="product-actions"><button class="product-buy-button" data-buy-now-card="${escapeHtml(product.id)}">View details</button>${whatsappButton(product, null, "product-whatsapp-button")}</div>
    </article>
  `).join("");
  byId("empty-state").classList.toggle("hidden", products.length > 0);
  if (!products.length) {
    byId("empty-state").querySelector("h3").textContent = "No products found.";
    byId("empty-state").querySelector("p").textContent = "Try another search or category.";
  }
}

function whatsappButton(product, size, className = "whatsapp-button") {
  const sizeText = size ? `Size: ${size}.` : "Please confirm the available size.";
  const message = `Hello SK Wholesaler, I would like to order ${product.name} (${money(product.price_cents)}). ${sizeText}`;
  return `<a class="${className}" href="https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener noreferrer">Order on WhatsApp</a>`;
}

function setCategory(category) {
  state.category = category;
  document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.category === category));
  renderProducts();
  byId("shop").scrollIntoView({ behavior: "smooth", block: "start" });
}

function productById(id) {
  return state.products.find((product) => product.id === id);
}

function openModal(id) {
  document.querySelectorAll(".modal-wrap").forEach((modal) => modal.classList.add("hidden"));
  byId(id).classList.remove("hidden");
  document.body.classList.add("no-scroll");
}

function closeModals() {
  document.querySelectorAll(".modal-wrap").forEach((modal) => modal.classList.add("hidden"));
  if (!document.querySelector(".drawer.open")) document.body.classList.remove("no-scroll");
}

function openDrawer(id) {
  closeModals();
  document.querySelectorAll(".drawer").forEach((drawer) => {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  });
  byId(id).classList.add("open");
  byId(id).setAttribute("aria-hidden", "false");
  overlay.classList.add("visible");
  document.body.classList.add("no-scroll");
}

function closeDrawers() {
  document.querySelectorAll(".drawer").forEach((drawer) => {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  });
  overlay.classList.remove("visible");
  if (!document.querySelector(".modal-wrap:not(.hidden)")) document.body.classList.remove("no-scroll");
}

function showProduct(id) {
  const product = productById(id);
  if (!product) return;
  state.openProductId = id;
  const modal = byId("product-modal");
  modal.innerHTML = `
    <button class="close-button product-modal-close" data-close-modal aria-label="Close product details">×</button>
    <div class="product-modal-image"><img src="${imageUrl(product.image, 1100)}" alt="${escapeHtml(product.name)}"></div>
    <div class="product-modal-copy"><span class="eyebrow">${escapeHtml(product.category)} · ${escapeHtml(product.color)}</span><h2>${escapeHtml(product.name)}</h2>
      <div class="modal-rating"><span>★</span> ${Number(product.rating).toFixed(1)} <span>(${product.reviews} reviews)</span></div>
      <p class="modal-price">${money(product.price_cents)} ${product.compare_at_cents ? `<del>${money(product.compare_at_cents)}</del>` : ""}</p>
      <p class="modal-description">${escapeHtml(product.description)}</p><p class="variant-label">Choose an option <span id="selected-size-label">${escapeHtml(product.sizes[0])}</span></p>
      <div class="size-options">${product.sizes.map((size, index) => `<button class="size-option ${index === 0 ? "selected" : ""}" data-size="${escapeHtml(size)}">${escapeHtml(size)}</button>`).join("")}</div>
      <p class="stock-note">${product.stock > 0 ? `In stock: ${product.stock}` : "Out of stock"}</p>
      <div class="product-modal-actions">${whatsappButton(product, product.sizes[0], "button button-dark modal-whatsapp") }<button class="button add-to-bag" data-add-product="${escapeHtml(product.id)}" ${product.stock < 1 ? "disabled" : ""}>Add to cart</button></div>
      <button class="modal-wishlist" data-heart="${escapeHtml(product.id)}">${state.wishlist.includes(product.id) ? "♥ Saved to your wishlist" : "♡ Save for later"}</button>
    </div>`;
  openModal("product-modal-wrap");
}

function addToCart(product, size, quantity = 1) {
  const existing = state.cart.find((item) => item.productId === product.id && item.size === size);
  const maxQuantity = Math.min(10, product.stock);
  if (existing) existing.quantity = Math.min(maxQuantity, existing.quantity + quantity);
  else state.cart.push({ productId: product.id, size, quantity: Math.min(maxQuantity, quantity) });
  persist();
  renderCart();
  announce(`${product.name} added to cart.`);
}

function cartDetails() {
  return state.cart.map((item) => {
    const product = productById(item.productId);
    return product ? { ...item, product, quantity: Math.min(item.quantity, product.stock) } : null;
  }).filter((item) => item && item.quantity > 0);
}

function renderCart() {
  const items = cartDetails();
  const content = byId("cart-content");
  const footer = byId("cart-footer");
  updateCounts();
  if (!items.length) {
    content.innerHTML = `<div class="drawer-empty"><span class="empty-mark">✳</span><h3>Your cart is empty.</h3><p>Add products to your cart to see them here.</p><button class="button button-dark" data-close-drawer>Shop products <span>↗</span></button></div>`;
    footer.innerHTML = "";
    return;
  }
  content.innerHTML = items.map((item) => `
    <article class="cart-item"><img src="${imageUrl(item.product.image, 280)}" alt="${escapeHtml(item.product.name)}">
      <div class="cart-item-info"><div class="cart-item-top"><div><h3>${escapeHtml(item.product.name)}</h3><span>${escapeHtml(item.product.color)} · ${escapeHtml(item.size)}</span></div><button class="remove-item" data-remove="${escapeHtml(item.productId)}" data-size="${escapeHtml(item.size)}" aria-label="Remove ${escapeHtml(item.product.name)}">×</button></div>
        <div class="cart-item-bottom"><div class="quantity-control"><button data-quantity="-1" data-product-id="${escapeHtml(item.productId)}" data-size="${escapeHtml(item.size)}" aria-label="Decrease quantity">−</button><span>${item.quantity}</span><button data-quantity="1" data-product-id="${escapeHtml(item.productId)}" data-size="${escapeHtml(item.size)}" aria-label="Increase quantity">+</button></div><strong>${money(item.product.price_cents * item.quantity)}</strong></div>
      </div>
    </article>`).join("");
  const subtotal = items.reduce((sum, item) => sum + item.product.price_cents * item.quantity, 0);
  const message = [
    "Hello SK Wholesaler, I would like to place this order:",
    ...items.map((item) => `- ${item.product.name} | Option: ${item.size} | Quantity: ${item.quantity} | ${money(item.product.price_cents * item.quantity)}`),
    `Items subtotal: ${money(subtotal)}`,
    "Please confirm availability and the final total."
  ].join("\n");
  const orderUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  footer.innerHTML = `<div class="cart-total-line"><span>Items subtotal</span><span>${money(subtotal)}</span></div><p class="cart-tax-note">Confirm availability and your final total with us on WhatsApp.</p><a class="button button-dark checkout-button" id="whatsapp-order" href="${orderUrl}" target="_blank" rel="noopener noreferrer">Order on WhatsApp <span>↗</span></a><button class="continue-shopping" data-close-drawer>Keep looking around</button>`;
}

function renderWishlist() {
  const items = state.wishlist.map(productById).filter(Boolean);
  byId("wishlist-content").innerHTML = items.length ? items.map((product) => `
    <article class="cart-item wishlist-item"><img src="${imageUrl(product.image, 280)}" alt="${escapeHtml(product.name)}"><div class="cart-item-info"><div class="cart-item-top"><div><h3>${escapeHtml(product.name)}</h3><span>${money(product.price_cents)}</span></div><button class="remove-item" data-heart="${escapeHtml(product.id)}" aria-label="Remove from wishlist">×</button></div><button class="wishlist-add" data-product="${escapeHtml(product.id)}">Take a closer look ↗</button></div></article>`).join("")
    : `<div class="drawer-empty"><span class="empty-mark">♡</span><h3>Your wishlist is empty.</h3><p>Save products here to find them later.</p><button class="button button-dark" data-close-drawer>Shop products <span>↗</span></button></div>`;
}

function toggleWishlist(id) {
  if (state.wishlist.includes(id)) {
    state.wishlist = state.wishlist.filter((item) => item !== id);
    announce("Removed from your wishlist.");
  } else {
    state.wishlist.push(id);
    announce("Saved to your wishlist.");
  }
  persist();
  renderProducts();
  renderWishlist();
  if (state.openProductId) showProduct(state.openProductId);
}

async function refreshProducts() {
  try {
    const response = await api("/api/products");
    state.products = response.products;
    renderProducts();
    renderCart();
    renderWishlist();
  } catch (error) {
    grid.innerHTML = `<div class="load-error"><h3>Products could not load.</h3><p>${escapeHtml(error.message)}</p><button class="text-link" id="retry-load">Try again ↗</button></div>`;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest("[data-home]")) {
    state.category = "All";
    state.query = "";
    byId("search-input").value = "";
    document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.home !== undefined));
    renderProducts();
    window.scrollTo({ top: 0, behavior: "smooth" });
    byId("main-nav").classList.remove("mobile-open");
  }
  const categoryButton = target.closest("[data-category]");
  if (categoryButton) {
    setCategory(categoryButton.dataset.category);
    byId("main-nav").classList.remove("mobile-open");
  }
  const productButton = target.closest("[data-product]");
  if (productButton) {
    closeDrawers();
    showProduct(productButton.dataset.product);
  }
  const buyNowCard = target.closest("[data-buy-now-card]");
  if (buyNowCard) showProduct(buyNowCard.dataset.buyNowCard);
  const heart = target.closest("[data-heart]");
  if (heart) {
    event.stopPropagation();
    toggleWishlist(heart.dataset.heart);
  }
  const sizeButton = target.closest("[data-size]");
  if (sizeButton) {
    sizeButton.parentElement.querySelectorAll(".size-option").forEach((button) => button.classList.remove("selected"));
    sizeButton.classList.add("selected");
    byId("selected-size-label").textContent = sizeButton.dataset.size;
    const product = productById(state.openProductId);
    const whatsapp = byId("product-modal").querySelector(".modal-whatsapp");
    if (product && whatsapp) whatsapp.outerHTML = whatsappButton(product, sizeButton.dataset.size, "whatsapp-button modal-whatsapp");
  }
  const addButton = target.closest("[data-add-product]");
  if (addButton) {
    const product = productById(addButton.dataset.addProduct);
    const selected = byId("product-modal").querySelector(".size-option.selected");
    if (product && selected) {
      addToCart(product, selected.dataset.size);
      closeModals();
      openDrawer("cart-drawer");
    }
  }
  const remove = target.closest("[data-remove]");
  if (remove) {
    state.cart = state.cart.filter((item) => !(item.productId === remove.dataset.remove && item.size === remove.dataset.size));
    persist();
    renderCart();
  }
  const quantityButton = target.closest("[data-quantity]");
  if (quantityButton) {
    const product = productById(quantityButton.dataset.productId);
    const cartItem = state.cart.find((item) => item.productId === quantityButton.dataset.productId && item.size === quantityButton.dataset.size);
    if (product && cartItem) {
      cartItem.quantity += Number(quantityButton.dataset.quantity);
      if (cartItem.quantity < 1) state.cart = state.cart.filter((item) => item !== cartItem);
      else if (cartItem.quantity > Math.min(10, product.stock)) {
        cartItem.quantity = Math.min(10, product.stock);
        announce("That's all the stock we have right now.");
      }
      persist();
      renderCart();
    }
  }
  if (target.closest("#cart-toggle")) {
    renderCart();
    openDrawer("cart-drawer");
  }
  if (target.closest("#wishlist-toggle")) {
    renderWishlist();
    openDrawer("wishlist-drawer");
  }
  if (target.closest("#search-toggle")) {
    const searchBox = byId("search-box");
    searchBox.classList.toggle("search-open");
    if (searchBox.classList.contains("search-open")) byId("search-input").focus();
    else {
      byId("search-input").value = "";
      state.query = "";
      renderProducts();
    }
  }
  if (target.closest("#shop-collection") || target.closest("#view-all")) {
    state.category = "All";
    document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.category === "All"));
    renderProducts();
    byId("shop").scrollIntoView({ behavior: "smooth" });
  }
  if (target.closest("#clear-filters")) {
    state.category = "All";
    state.query = "";
    byId("search-input").value = "";
    renderProducts();
  }
  if (target.closest("#menu-button")) byId("main-nav").classList.toggle("mobile-open");
  if (target.closest("[data-close-drawer]")) closeDrawers();
  if (target === overlay) closeDrawers();
  if (target.closest("[data-close-modal]")) closeModals();
  if (target.closest("#retry-load")) refreshProducts();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDrawers();
    closeModals();
    byId("main-nav").classList.remove("mobile-open");
  }
});

byId("search-input").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  renderProducts();
});
byId("sort-select").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderProducts();
});
byId("newsletter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = byId("newsletter-message");
  const email = new FormData(event.currentTarget).get("email");
  message.textContent = "Saving your spot…";
  message.classList.remove("is-error");
  try {
    const result = await api("/api/newsletter", { method: "POST", body: JSON.stringify({ email }) });
    message.textContent = result.message;
    event.currentTarget.reset();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
  }
});

refreshProducts();
loadBlogPreview();
persist();
