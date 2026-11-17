# Release 1 SPA — nginx serves static assets and proxies /api/v1 to the backend service.
FROM node:20-alpine AS build

WORKDIR /app

# The SPA is served under a path prefix (/attendance-v2/), not at the domain root. vite.config
# reads VITE_BASE_PATH and defaults to '/', so building without it produces an index.html whose
# assets point at /assets/… — which the reverse proxy does not map to this app, and the browser
# renders a blank page with every script 404ing. Default the base to the deployment path so a plain
# `docker build` yields a usable image; override it for a different prefix.
ARG VITE_BASE_PATH=/attendance-v2/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Unprivileged image: runs as UID 101 and listens on 8080 by default.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY deploy/docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
