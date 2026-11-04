# Atualizador do NoPaper: só as ferramentas (Node, git, Docker CLI + compose).
# O código (updater/server.mjs) vem da pasta do projeto montada em /project, então ele é
# atualizado junto com o sistema, sem reconstruir esta imagem.
FROM node:22-alpine
RUN apk add --no-cache git docker-cli docker-cli-compose docker-cli-buildx ca-certificates tini \
 && git config --system --add safe.directory '*'
WORKDIR /project
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/project/updater/server.mjs"]
