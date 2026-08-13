FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
LABEL org.opencontainers.image.title="ChimpMaera BI Agent M0" \
      io.chimpmaera.bi.role="bounded-agent-ui"
WORKDIR /app
COPY --chown=10001:10001 package.json ./
COPY --chown=10001:10001 src ./src
USER 10001:10001
CMD ["node", "src/server.mjs"]
