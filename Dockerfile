# Optional: build a proper image instead of the volume-mount compose setup.
# docker build -t ludo-rooms . && docker run -d -p 8090:3000 --restart unless-stopped ludo-rooms
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
