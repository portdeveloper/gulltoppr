# Use the official Rust image as a base
FROM rust:latest as builder

# Create a working directory
WORKDIR /usr/src/heimdall-api

# Copy your source tree
COPY ./ .

# Build your application
RUN cargo build --release

# Now, start a new stage to create a lighter final image
FROM ubuntu:latest

# Install any dependencies you might have
RUN apt-get update && apt-get install -y libssl-dev pkg-config ca-certificates strace gdb && rm -rf /var/lib/apt/lists/*

# Copy the build artifact from the build stage
COPY --from=builder /usr/src/heimdall-api/target/release/heimdall_api .

# Copy the Heimdall binary from the project directory
COPY heimdall /usr/local/bin/heimdall

# Ensure the binary is executable
RUN chmod +x /usr/local/bin/heimdall

# Expose the port the app runs on
EXPOSE 8080

# Run the binary
CMD ["./heimdall_api"]
