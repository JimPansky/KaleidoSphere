FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
LABEL org.opencontainers.image.title="ChimpMaera BI Control M0" \
      io.chimpmaera.bi.role="read-only-analyzer-and-superset-controller"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 query-packs ./query-packs
COPY --chown=10001:10001 fixtures ./fixtures
USER 10001:10001
CMD ["node", "src/server.mjs"]
