# RAE Attendance V2 API image.
# Runtime configuration is supplied by the environment; nothing secret is baked in.
FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/src ./src

ENV NODE_ENV=production \
    PORT=3210 \
    HOST=0.0.0.0 \
    DATA_SOURCE=mariadb

EXPOSE 3210

# Run as the unprivileged user that node:alpine already provides.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/v1/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
