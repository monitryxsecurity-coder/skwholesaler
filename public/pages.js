const contactForm = document.getElementById("contact-form");
if (contactForm) {
  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.getElementById("contact-message");
    const button = document.getElementById("contact-submit");
    const body = Object.fromEntries(new FormData(contactForm).entries());
    message.textContent = "Sending your note…";
    message.classList.remove("is-error");
    button.disabled = true;
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "We couldn't send your note. Please try again.");
      message.textContent = result.message;
      contactForm.reset();
    } catch (error) {
      message.textContent = error.message || "We couldn't send your note. Please try again.";
      message.classList.add("is-error");
    } finally {
      button.disabled = false;
    }
  });
}
