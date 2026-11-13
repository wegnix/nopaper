# ---------- build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @nopaper/shared --workspace @nopaper/api --include-workspace-root=false --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @nopaper/shared && npm run build -w @nopaper/api \
 && npm prune --omit=dev --workspace @nopaper/shared --workspace @nopaper/api --include-workspace-root=false

# ---------- runtime
FROM node:22-alpine
# pg_dump + rclone + ssh para backups agendados
# poppler-utils + tesseract + zbar (+ imagemagick, que abre as imagens para o zbar): leitura (OCR) de boletos, notas e comprovantes escaneados ou em foto;
# qpdf: abre PDFs protegidos com as regras de senha do espaço
RUN apk add --no-cache postgresql17-client rclone openssh-client tzdata tini su-exec \
    poppler-utils tesseract-ocr tesseract-ocr-data-por zbar imagemagick qpdf
ENV NODE_ENV=production TZ=America/Sao_Paulo PORT=3000 HOST=0.0.0.0 \
    STORAGE_DIR=/data/uploads BACKUP_DIR=/data/backups
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY docker/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN mkdir -p /data/uploads /data/backups && chown -R node:node /data
# sem USER: o entrypoint corrige o dono das pastas montadas e então roda como "node"
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/api-entrypoint.sh"]
CMD ["node", "dist/server.js"]
