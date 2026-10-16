# Stage 1: Build the React application using Bun
FROM oven/bun:alpine AS build

WORKDIR /app

# Copy package files and install dependencies with Bun
COPY package.json bun.lock ./
RUN bun install

# Copy application source code and build it
COPY . .
ENV VITE_API_URL=""
RUN bun run build

# Stage 2: Serve the application with Nginx
FROM nginx:alpine

# Patch OS-level vulnerabilities (zlib 1.3.2-r0 -> 1.3.2-r1)
RUN apk upgrade --no-cache

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from the build stage
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
