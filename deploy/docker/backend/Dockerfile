# RAE Attendance V2 API — fixture mode for CI smoke; production uses env + real DATA_SOURCE.
FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/src ./src

ENV NODE_ENV=production \
    PORT=3210 \
    HOST=0.0.0.0 \
    DATA_SOURCE=fixture \
    JWT_SECRET=replace-at-runtime

EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/v1/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
