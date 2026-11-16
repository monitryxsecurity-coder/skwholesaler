# Northflank deployment

This deploys the current Node.js app as a single container and keeps its SQLite database on a persistent volume. Northflank provides a generated HTTPS hostname, so a custom domain is optional.

**Free-tier limitation:** Northflank describes its Developer Sandbox as for hobby projects and testing, not production. Creating resources requires adding a payment method, even on the free plan. Review the current plan, resource allowance, and billing dashboard before creating resources. This guide does not authorize paid resources. Do not use this setup for real customer data or live commerce unless you have reviewed the provider's production limitations and arranged backups.

## 1. Connect the repository

1. Sign in to Northflank and connect the GitHub account that owns `monitryxsecurity-coder/skwholesaler`.
2. Create a project and a service from this repository's `main` branch.
3. Choose Dockerfile build; set the Dockerfile path to `/Dockerfile` and the build context to `/`.
4. Choose the free Developer Sandbox only if its current terms and projected usage are acceptable to you.

The Docker image runs as the unprivileged `node` user, listens on `0.0.0.0:8080`, and stores SQLite at `/app/data/smartcart.sqlite`. `.dockerignore` excludes local databases and environment files from the build.

## 2. Add persistent storage and environment variables

Create a persistent volume and attach it to the service:

- Mount path: `/app/data`
- Access mode: single read/write instance
- Keep the service scaled to one instance; do not horizontally scale a single SQLite database.

Northflank assigns persistent-volume ownership based on the user/group in the image. This image runs as `node:node`; if the service reports a filesystem permission error, check the volume's ownership and mount configuration before restarting.

Configure these runtime environment variables in the service:

```text
TRUST_PROXY=true
SMARTCART_ADMIN_EMAIL=your-admin-email
SMARTCART_ADMIN_PASSWORD=your-unique-password-of-at-least-12-characters
```

Do not upload `.env` or commit passwords. Northflank supplies the exposed port at runtime; the image listens on port 8080 by default. Expose port 8080 as a **public HTTP** service port in Northflank networking. TLS is terminated by Northflank's public ingress; `TRUST_PROXY=true` enables secure cookies and correct same-origin checks behind that trusted proxy.

## 3. Deploy and verify

Wait for the build and deployment to become healthy. Use the generated public hostname from the service's Networking page:

- Storefront: `https://YOUR_GENERATED_HOSTNAME/`
- Admin: `https://YOUR_GENERATED_HOSTNAME/admin.html`
- Tracking: `https://YOUR_GENERATED_HOSTNAME/tracking.html`
- Health: `https://YOUR_GENERATED_HOSTNAME/api/health`

Sign in to the admin page, create a test manual order, check it on the tracking page, restart the service, and verify it remains. Confirm that the service has only one instance and that its SQLite volume is mounted at `/app/data`.

The first deployment creates a new database with seed products and journal posts. It does not import the private local `data/` directory. Do not include customer records in an image or Git commit. If importing local data is necessary, arrange a secure, private transfer directly into the mounted volume before accepting orders.

## Billing, backups, and scale

- Check the service and volume's projected costs and actual usage in Northflank before deployment; configure billing alerts.
- Free-tier availability and usage allowances can change. Do not assume the Developer Sandbox is suitable for production or that usage beyond its allowance will remain free.
- Back up the SQLite database to a separate private location and periodically verify that backups can be restored.
- Use one instance only. SQLite on a single read/write volume is not a horizontally scalable or highly available database.
- The generated HTTPS hostname avoids buying a domain but does not remove the need for provider-account access and its billing requirements.
