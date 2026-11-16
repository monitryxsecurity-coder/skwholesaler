const storefrontThemeKey = "smartcart-storefront-theme";
const storefrontThemeButton = document.querySelector(".theme-toggle");

function applyStorefrontTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  if (storefrontThemeButton) {
    storefrontThemeButton.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} theme`);
    storefrontThemeButton.setAttribute("title", `Switch to ${isDark ? "light" : "dark"} theme`);
    storefrontThemeButton.querySelector("span").textContent = isDark ? "☀" : "☾";
  }
}

applyStorefrontTheme(localStorage.getItem(storefrontThemeKey) || "light");

storefrontThemeButton?.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(storefrontThemeKey, theme);
  applyStorefrontTheme(theme);
});
