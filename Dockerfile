FROM node:22-bookworm-slim

WORKDIR /opt/larder

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npm", "start"]
