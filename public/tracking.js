const trackingForm = document.getElementById("tracking-form");
const trackingMessage = document.getElementById("tracking-message");
const trackingResult = document.getElementById("tracking-result");
const trackingHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

trackingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  trackingMessage.textContent = "Looking up your order…";
  trackingMessage.classList.remove("is-error");
  trackingResult.innerHTML = "";
  try {
    const response = await fetch("/api/tracking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingId: new FormData(trackingForm).get("trackingId") })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "We couldn't look up that tracking ID.");
    const order = result.order;
    trackingMessage.textContent = "";
    trackingResult.innerHTML = `<section class="tracking-result"><span class="eyebrow">Tracking ID ${trackingHtml(order.tracking_id)}</span><h2>${trackingHtml(order.status)}</h2><p>${trackingHtml(order.items_summary)}</p><p>Last updated ${new Date(order.updated_at).toLocaleString()}</p></section>`;
  } catch (error) {
    trackingMessage.textContent = error.message || "We couldn't look up that tracking ID.";
    trackingMessage.classList.add("is-error");
  }
});
