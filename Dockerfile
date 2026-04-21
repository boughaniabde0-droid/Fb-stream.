FROM node:18-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install Node dependencies
RUN npm install

# Copy all files
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
