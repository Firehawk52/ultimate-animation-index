FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json README.md ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY data ./data
RUN npm run build:catalog
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "require('node:http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["npm", "start"]
