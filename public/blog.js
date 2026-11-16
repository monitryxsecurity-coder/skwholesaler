const blogEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const blogImage = (image) => `https://images.unsplash.com/${encodeURIComponent(image)}?auto=format&fit=crop&w=1400&q=85`;
const blogDate = (date) => new Date(date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

async function loadJournal() {
  const container = document.getElementById("journal-list");
  if (!container) return;
  try {
    const response = await fetch("/api/blogs");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Stories could not be loaded.");
    container.innerHTML = result.posts.map((post) => `
      <article class="journal-list-card">
        <a class="journal-list-image" href="/blog-post.html?slug=${encodeURIComponent(post.slug)}"><img src="${blogImage(post.image)}" alt="" loading="lazy"></a>
        <div class="journal-list-copy"><span class="eyebrow">${blogDate(post.published_at)} · ${blogEscape(post.author)}</span>
          <h2><a href="/blog-post.html?slug=${encodeURIComponent(post.slug)}">${blogEscape(post.title)}</a></h2>
          <p>${blogEscape(post.excerpt)}</p><a class="text-link" href="/blog-post.html?slug=${encodeURIComponent(post.slug)}">Read the story <span>↗</span></a>
        </div>
      </article>`).join("") || `<div class="journal-empty-state"><span class="eyebrow">A little quiet for now</span><h2>New stories are <em>on their way.</em></h2><a class="text-link" href="/">Back to the shop <span>↗</span></a></div>`;
  } catch (error) {
    container.innerHTML = `<p class="journal-empty-state">${blogEscape(error.message)} <a href="/blog.html">Try again ↗</a></p>`;
  }
}

async function loadArticle() {
  const container = document.getElementById("blog-article");
  if (!container) return;
  const slug = new URLSearchParams(location.search).get("slug");
  if (!slug) {
    container.innerHTML = `<div class="journal-empty-state"><h1>That story is missing.</h1><a class="text-link" href="/blog.html">Back to the journal <span>↗</span></a></div>`;
    return;
  }
  try {
    const response = await fetch(`/api/blogs/${encodeURIComponent(slug)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "That story could not be found.");
    const post = result.post;
    const paragraphs = post.content.split(/\n{2,}/).filter(Boolean)
      .map((paragraph) => `<p>${blogEscape(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
    document.title = `${post.title} — SK Wholesaler`;
    container.innerHTML = `
      <article class="journal-article">
        <a class="back-to-journal" href="/blog.html">← Back to the journal</a>
        <header class="journal-article-heading"><span class="eyebrow">${blogDate(post.published_at)} · ${blogEscape(post.author)}</span><h1>${blogEscape(post.title)}</h1><p>${blogEscape(post.excerpt)}</p></header>
        <img class="journal-article-hero" src="${blogImage(post.image)}" alt="${blogEscape(post.title)}">
        <div class="journal-article-content">${paragraphs}</div>
        <a class="text-link" href="/blog.html">More from the journal <span>↗</span></a>
      </article>`;
  } catch (error) {
    container.innerHTML = `<div class="journal-empty-state"><span class="eyebrow">A little hiccup</span><h1>${blogEscape(error.message)}</h1><a class="text-link" href="/blog.html">Back to the journal <span>↗</span></a></div>`;
  }
}

loadJournal();
loadArticle();
