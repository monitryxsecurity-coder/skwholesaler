# SK Wholesaler

SK Wholesaler is a responsive storefront with a product catalog, a protected staff admin area, a public journal, About and Privacy pages, and contact links. Customers place orders by sending a prefilled WhatsApp message to +92 329 8454735. The contact page links to ak_furqan@yahoo.com. The site uses a vanilla JavaScript frontend and a Node.js HTTP server with SQLite; it has no npm dependencies.

## Requirements

- Node.js 22.5 or newer (the server uses the built-in `node:sqlite` module)

## Run locally

```powershell
npm.cmd start
```

Open [http://localhost:4173](http://localhost:4173). The database and fictional product and journal seed data are created automatically in `data/smartcart.sqlite` on the first run. Set `PORT` or `DB_PATH` in your environment to change the server port or database path. The server loads a local `.env` file on startup; `.env` is ignored by Git.

### Admin access

The admin area is at [http://localhost:4173/admin.html](http://localhost:4173/admin.html). There is no built-in admin account or default password. It remains locked until you configure an administrator email and a strong password of at least 12 characters in your private `.env` file:

```powershell
Copy-Item .env.example .env
# Edit .env and set SMARTCART_ADMIN_EMAIL and a private SMARTCART_ADMIN_PASSWORD.
npm.cmd start
```

Alternatively, set those two environment variables in the shell before starting. The server reads `.env` at startup; changing it requires a server restart.

Keep the password private; do not commit it to source control or expose the admin service to the public internet without HTTPS and appropriate deployment safeguards. Admin sessions use an HttpOnly, SameSite=Strict cookie, expire after 12 hours, and require a CSRF token for changes. The admin can manage products and categories, journal stories, and contact inquiries. The admin area includes a WhatsApp order tracker. After confirming an order in WhatsApp, staff enters the same 6–32 character alphanumeric tracking ID given to the customer, plus their name, WhatsApp number, and agreed order details. The admin can send the tracking link by WhatsApp and update the status; customers can check it at `/tracking.html`. These tracking records are stored in the database. Old checkout orders have been removed.

The public storefront links to About, Privacy, Contact, and the Journal. Admin sign-in is intentionally not linked from public storefront navigation; open `/admin.html` directly. Contact form messages are saved to the database and appear in the admin Inquiries panel. Email links open the visitor's default mail app; sending email directly from the website would require separately configured mail delivery.

### Currency and pricing

Product prices are displayed in Pakistani rupees (PKR). The cart calculates an item subtotal and opens WhatsApp with a prefilled list of products, options, quantities, and prices. Availability and the final total are confirmed in the WhatsApp conversation.

For automatic server restarts during development:

```powershell
npm.cmd run dev
```

## Deploy on a persistent VM

GitHub Pages cannot run this Node.js API or persist its SQLite database. To keep the existing features without migrating the database, use a Node.js host with persistent disk storage. The [Northflank deployment guide](./deploy/northflank/README.md) covers a single-instance container with SQLite volume storage and an automatic HTTPS hostname; note that Northflank describes its free Developer Sandbox as non-production and requires a payment method. The [VM deployment guide](./deploy/oracle-cloud/README.md) covers a persistent-disk VM alternative. Verify current provider terms and usage before creating resources.

The database must stay outside the Git checkout on persistent storage. Do not deploy the local `.env` or `data/` directory. Configure the admin credentials on the VM, and use HTTPS before handling admin sign-in or customer information.

## Included

- Responsive storefront, product categories, search, price/rating sorting, product details and size selection
- Persistent browser cart and wishlist
- Product and cart ordering through prefilled WhatsApp messages
- Admin-created confirmed WhatsApp orders with customer-provided tracking IDs and manually updated customer-visible statuses
- Public order tracking by tracking ID
- Electronics collection with featured products and a homepage background feature
- Newsletter signup stored in SQLite
- Public Journal with seed stories and admin-managed drafts/publishing
- Customer storefront theme toggle with saved light/dark preference and Manrope typography
- Admin sign-in, manual WhatsApp-order tracking, product and category management, blog management, and contact inquiry management
- Fictional seed products; images and web fonts load from Unsplash and Google Fonts when online

## API

- `GET /api/health`
- `GET /api/products?q=...&category=...&sort=...`
- `POST /api/tracking`
- `POST /api/newsletter`
- `POST /api/contact`
- `GET /api/blogs` and `GET /api/blogs/:slug` (published stories only)
- `GET /api/admin/manual-orders` and `POST /api/admin/manual-orders` are admin-only; edits/deletes are also under `/api/admin/manual-orders/:id`. Admin write requests require a CSRF token.

## Notes before production

This project is a starter store, not a production-ready commerce platform. WhatsApp ordering opens an external WhatsApp conversation; an order is only recorded after staff confirms it and creates a tracking record in admin. The legacy order and payment API remains for compatibility but is not part of the storefront order flow. Use HTTPS, configure backups and monitoring, and review applicable privacy rules before production. When TLS terminates at a trusted local reverse proxy, set `TRUST_PROXY=true` and bind the app to `127.0.0.1`; never expose the app port directly when trusting forwarded headers. The admin login is for one operator configured by environment variables, not a multi-user account system.

## Verification

```powershell
node --check server.js
node --check public/app.js
node --check public/admin.js
node --check public/blog.js
npm.cmd test
```
