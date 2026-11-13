FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @nopaper/shared --workspace @nopaper/web --include-workspace-root=false --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @nopaper/shared && npm run build -w @nopaper/web

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# roda na partida, antes do nginx: aplica EMBED_ALLOWED_ORIGINS aos cabeçalhos
COPY --chmod=755 docker/nginx-embed.sh /docker-entrypoint.d/40-nopaper-embed.sh
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/healthz || exit 1
