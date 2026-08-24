# DEMO FIXTURE — intentionally insecure infrastructure config.
FROM node:14
USER root
ENV API_TOKEN=ghp_democcccccccccccccccccccccccccccccccc
COPY . /app
WORKDIR /app
RUN npm install --unsafe-perm
EXPOSE 3000
CMD ["node", "src/index.js"]
