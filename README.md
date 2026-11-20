# Request Checklist

**Send one link. See exactly what’s still missing.**

Request Checklist is a self-hosted file request workspace. Make a checklist of the photos, documents, and other files a client owes you, send them one link, and download everything by checklist item in a single ZIP.

1. Sign in, name a file request, and list what you need. Each item can specify instructions and a number of files.
2. Share the upload link. Recipients can send files from a browser without signing in, and return to the same link to finish.
3. Track receipt by item, download the ZIP, and reuse the checklist on the next project.

Upload links are usable by anyone who has the link and expire after 30 days. Recipients see file counts. Only the administrator can view filenames and download the archive. Close a link early to stop uploads. Delete a request in the workspace to remove its files. Use separate requests for separate clients.

## Run locally

Requires Node.js 24 and npm.

```sh
npm ci
export FILE_REQUEST_PASSWORD="$(openssl rand -hex 24)"
printf 'Local admin password: %s\n' "$FILE_REQUEST_PASSWORD"
npm start
```

Open [http://localhost:3000](http://localhost:3000). Run `npm test` to check the HTTP flow and file persistence.

## Deploy on Hostinger VPS

[![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/docker-hosting?compose_url=https%3A%2F%2Fraw.githubusercontent.com%2Fxpress-harshad%2Frequest-checklist%2Fmain%2Fdocker-compose.yml)

The button opens Hostinger’s standard Docker deployment flow. On an existing Hostinger VPS, you can also import the Compose URL in **Docker Manager → Compose from URL**. The Compose file builds the app from this repository.

1. Point a domain or subdomain to your VPS. Use an unused host with ports 80 and 443 available for the bundled HTTPS proxy. Set `FILE_REQUEST_DOMAIN` to the hostname only, such as `files.example.com`.
2. Set `FILE_REQUEST_PASSWORD` to a unique strong password of at least 16 characters. Keep it in the deployment environment. If your Compose importer does not provide variable entry, set the variables directly in its private Compose editor or use an SSH session with an untracked `.env` in the checkout.
3. Start the stack, wait for Caddy to issue the TLS certificate, and open the HTTPS domain. Sign in and send a test upload before sharing real requests.

For a checked-out development copy, set `FILE_REQUEST_SOURCE=.` before running `docker compose up -d --build`. The bundled Compose stack uses a separate Caddy container. On a VPS that already has a reverse proxy, use the app container with your existing HTTPS proxy and set `FILE_REQUEST_ORIGIN` to its public HTTPS origin.

## Storage and limits

The app runs as a single Node process. Keep the entire data directory together on a persistent local volume, including SQLite and the upload files. The provided Compose stack stores it in the `requests` volume. For a consistent backup, stop the app and back up the volume, then restart. Do not use `docker compose down -v` if you need to retain requests.

| Variable | Default or requirement |
| --- | --- |
| `FILE_REQUEST_PASSWORD` | Required. At least 16 characters. |
| `FILE_REQUEST_ORIGIN` | Localhost by default. Set to your HTTPS origin behind a proxy. |
| `FILE_REQUEST_DATA` | Local `data/`, or `/app/data` in Docker. |
| `FILE_REQUEST_MAX_MB` | 25 MiB per upload. Configurable from 1 to 100. |
| `FILE_REQUEST_STORAGE_MB` | 2,048 MiB of stored uploads. Choose a value below available disk space. |

The server streams incoming files to disk and sanitizes filenames for export. Files supplied by clients may still contain unsafe content. Handle them as you would an email attachment. Keep the volume private and configure backups and retention for your deployment.

## License

[MIT](LICENSE)
