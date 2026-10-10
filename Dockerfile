# wx-bot container image. Mount a config at /etc/wx-bot/config.json and
# persist /state (login session, cursor, inbox) and /media.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/cloudflare/package.json packages/cloudflare/
RUN bun install --frozen-lockfile --production --filter @wx-bot/cli
COPY packages/core packages/core
COPY packages/cli packages/cli
ARG TARGETARCH
ARG VERSION=dev
RUN case "$TARGETARCH" in amd64) T=bun-linux-x64-musl ;; arm64) T=bun-linux-arm64-musl ;; *) echo "unsupported $TARGETARCH" >&2; exit 1 ;; esac && \
    cd packages/cli && bun build src/main.ts --compile --minify --target=$T \
      --define WXBOT_VERSION="\"${VERSION}\"" --outfile /out/wx-bot

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata libstdc++ libgcc && \
    addgroup -S bot && adduser -S -G bot -h /state bot && \
    mkdir -p /state /media /etc/wx-bot && chown bot:bot /state /media
COPY --from=build /out/wx-bot /usr/local/bin/wx-bot
COPY LICENSE /licenses/wx-bot-LICENSE
USER bot
ENV HOME=/state
VOLUME ["/state", "/media"]
ENTRYPOINT ["wx-bot"]
CMD ["--config", "/etc/wx-bot/config.json", "run"]
