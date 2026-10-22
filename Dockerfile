FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server/server.js"]
