# abi.ninja engine — Node 22 service run via tsx (TS executed directly; no build
# step needed for an HTTP orchestration layer). The heimdall decompile work lives
# in the separate gulltoppr service, so this image stays small.
FROM node:22-slim

WORKDIR /app

# Install runtime deps only (tsx is a runtime dep so `npm start` works in prod).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
