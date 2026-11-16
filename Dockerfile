FROM node:24-alpine
ARG VERSION=development
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Github Observatory" \
      org.opencontainers.image.description="Self-hosted GitHub analytics with SQLite history and actionable drilldowns" \
      org.opencontainers.image.source="https://github.com/pbozzay/github-observatory" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir /data && chown 100:101 /data
ENV NODE_ENV=production OBSERVATORY_PORT=8080 OBSERVATORY_DATA_DIR=/data
USER 100:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.OBSERVATORY_PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/main.mjs"]
