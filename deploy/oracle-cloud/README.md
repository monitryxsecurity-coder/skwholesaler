# Persistent VM deployment

This keeps the existing Node.js and SQLite implementation. GitHub stores the code; a VM runs the site, and its persistent disk stores products, inquiries, newsletter signups, admin sessions, and tracking records. GitHub Pages by itself cannot run this backend.

This guide is written for an Ubuntu VM. Oracle Cloud has offered Always Free resources, but current eligibility, availability, and limits can change. Select only resources explicitly marked free and review the provider's terms before confirming. A domain name is needed for the HTTPS setup below.

## 1. Create the VM and repository

1. Create an empty, private or public GitHub repository and push this project. Ensure `.env` and `data/` are not committed; they are excluded by `.gitignore`.
2. Create an Ubuntu VM with persistent boot storage and allow inbound SSH, HTTP (80), and HTTPS (443) in both the cloud network rules and the VM firewall. Do not open port 4173.
3. Point your domain's DNS A record to the VM's public IP and wait for DNS to resolve.
4. SSH into the VM as its Ubuntu account.

## 2. Install Node.js and Nginx

Install Node.js 22 and Nginx:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs nginx
node --version
```

Confirm Node.js is at least 22.5. Create the service account and persistent data directory:

```sh
sudo useradd --system --home /opt/sk-wholesaler --shell /usr/sbin/nologin skwholesaler
sudo mkdir -p /opt/sk-wholesaler/current /var/lib/sk-wholesaler /etc/sk-wholesaler
sudo chown -R skwholesaler:skwholesaler /opt/sk-wholesaler /var/lib/sk-wholesaler
```

Clone your repository into `/opt/sk-wholesaler/current`, then make the checkout readable by the service:

```sh
sudo git clone YOUR_GITHUB_REPOSITORY_URL /opt/sk-wholesaler/current
sudo chown -R root:root /opt/sk-wholesaler/current
sudo chmod -R a+rX /opt/sk-wholesaler/current
```

## 3. Configure the admin account and persistent database

Create `/etc/sk-wholesaler/app.env` with your own admin email and a unique password of at least 12 characters. Do not put credentials in GitHub or in the repository:

```sh
sudo install -m 600 -o root -g root /dev/null /etc/sk-wholesaler/app.env
sudo nano /etc/sk-wholesaler/app.env
```

Set these values in that file:

```ini
PORT=4173
HOST=127.0.0.1
TRUST_PROXY=true
DB_PATH=/var/lib/sk-wholesaler/smartcart.sqlite
SMARTCART_ADMIN_EMAIL=YOUR_ADMIN_EMAIL
SMARTCART_ADMIN_PASSWORD=YOUR_UNIQUE_PASSWORD_AT_LEAST_12_CHARACTERS
```

The absolute database path is outside the code checkout, so updates to the app do not replace the database. Keep the VM's persistent disk and take backups; the disk is not a substitute for backups.

To preserve the current local catalog, blog content, inquiries, and tracking records, create a consistent snapshot of the local database before copying it. This reads the SQLite database safely even if its WAL file exists:

```powershell
node deploy/oracle-cloud/export-database.js
scp .\sk-wholesaler-deploy.sqlite ubuntu@YOUR_VM_IP:/tmp/sk-wholesaler.sqlite
```

The generated snapshot is Git-ignored. Transfer it only over SSH; it may contain customer information. On the VM, install it before the first service start (or stop the service first if it has already been started):

```sh
sudo systemctl stop sk-wholesaler
sudo install -o skwholesaler -g skwholesaler -m 600 /tmp/sk-wholesaler.sqlite /var/lib/sk-wholesaler/smartcart.sqlite
sudo rm /tmp/sk-wholesaler.sqlite
```

If you skip this, the app initializes a fresh database with its seed catalog and journal content; locally managed records will not be present.

Install and start the service:

```sh
sudo cp /opt/sk-wholesaler/current/deploy/oracle-cloud/sk-wholesaler.service.example /etc/systemd/system/sk-wholesaler.service
sudo systemctl daemon-reload
sudo systemctl enable --now sk-wholesaler
sudo systemctl status sk-wholesaler --no-pager
curl http://127.0.0.1:4173/api/health
```

## 4. Configure HTTPS

Replace `YOUR_DOMAIN` in the provided Nginx config with your domain, then enable it:

```sh
sudo sed 's/YOUR_DOMAIN/example.com/' /opt/sk-wholesaler/current/deploy/oracle-cloud/nginx-site.conf.example | sudo tee /etc/nginx/sites-available/sk-wholesaler
sudo ln -s /etc/nginx/sites-available/sk-wholesaler /etc/nginx/sites-enabled/sk-wholesaler
sudo nginx -t
sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

Replace `example.com` with your actual domain in both commands. Certbot configures HTTPS and renewal. The Nginx proxy overwrites `X-Forwarded-Proto`; the app trusts that header only because `TRUST_PROXY=true` and the Node server is bound to localhost. Do not expose port 4173 publicly.

Check `https://YOUR_DOMAIN/api/health`, then open `https://YOUR_DOMAIN/`, `/admin.html`, and `/tracking.html`. Sign in with the admin credentials configured above. Create a test tracking record, verify its public status, and check that the record remains after restarting the service.

## Update and back up

To deploy code updates without touching the SQLite database:

```sh
cd /opt/sk-wholesaler/current
sudo git pull --ff-only
sudo systemctl restart sk-wholesaler
sudo systemctl status sk-wholesaler --no-pager
```

For a simple consistent SQLite backup, briefly stop the service, copy the database to a separate secure backup location, then start the service:

```sh
sudo systemctl stop sk-wholesaler
sudo cp /var/lib/sk-wholesaler/smartcart.sqlite /PATH/TO/SECURE/BACKUP/
sudo systemctl start sk-wholesaler
```

Do not place backups in the Git repository or a publicly served directory. Restore only while the service is stopped, and preserve the `skwholesaler` ownership of the restored database.

## Admin and customer links

- Storefront: `https://YOUR_DOMAIN/`
- Admin: `https://YOUR_DOMAIN/admin.html`
- Customer tracking: `https://YOUR_DOMAIN/tracking.html`

All three pages use the same persistent database-backed server; no separate admin hosting or GitHub Pages deployment is needed.
