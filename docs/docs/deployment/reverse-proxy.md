# Reverse Proxy

!!! warning
    **Always put GitEcho behind a TLS-terminating reverse proxy** when exposing it beyond `localhost`. The login form sends credentials over plain HTTP otherwise.

## PUBLIC_URL

When running behind a reverse proxy that changes the host (Synology DSM portal, Traefik, nginx, subdomains), set `PUBLIC_URL` to your external URL(s):

```bash
PUBLIC_URL=https://gitecho.example.com
# Multiple origins:
PUBLIC_URL=https://gitecho.example.com,https://nas.local:5000
```

Without this, state-changing requests (add/remove repo, save settings, etc.) are rejected with **403 Forbidden** because the browser's `Origin` header doesn't match the container's internal host.

## Example Configurations

### Caddy

```
gitecho.example.com {
    reverse_proxy localhost:3000
}
```

Caddy automatically provisions and renews TLS certificates via Let's Encrypt.

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name gitecho.example.com;

    ssl_certificate     /etc/ssl/certs/gitecho.pem;
    ssl_certificate_key /etc/ssl/private/gitecho.key;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name gitecho.example.com;
    return 301 https://$host$request_uri;
}
```

### Traefik (Docker labels)

```yaml
services:
  gitecho:
    image: ghcr.io/tobihochzwei/gitecho:latest
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.gitecho.rule=Host(`gitecho.example.com`)"
      - "traefik.http.routers.gitecho.entrypoints=websecure"
      - "traefik.http.routers.gitecho.tls.certresolver=letsencrypt"
      - "traefik.http.services.gitecho.loadbalancer.server.port=3000"
    environment:
      PUBLIC_URL: "https://gitecho.example.com"
      MASTER_KEY: "your-64-hex-char-key"
    volumes:
      - gitecho-data:/data
      - gitecho-config:/config
      - gitecho-backups:/backups
```

### Synology DSM

When using Synology's built-in reverse proxy (Control Panel → Application Portal → Reverse Proxy):

1. Create a reverse proxy rule pointing to the GitEcho container's IP and port 3000
2. Set `PUBLIC_URL` to the DSM portal URL (e.g., `https://nas.local:5000`)
3. If using Synology shared folders as bind mounts, set `PUID` and `PGID` to match the host directory ownership
