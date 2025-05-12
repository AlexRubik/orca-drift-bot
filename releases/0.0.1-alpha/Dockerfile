# Use a minimal base image
FROM debian:bullseye-slim

# Set working directory
WORKDIR /app

# Install necessary runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Copy the executable and required files
COPY lp-bot-linux /app/
COPY config.json /app/
COPY keypair.json /app/

# Set executable permissions
RUN chmod +x /app/lp-bot-linux

# Use tini as the entrypoint
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/lp-bot-linux"]