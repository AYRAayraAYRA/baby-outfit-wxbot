FROM node:20-alpine
WORKDIR /app
COPY package.json index.js ./
ENV PORT=80
EXPOSE 80
CMD ["node", "index.js"]
