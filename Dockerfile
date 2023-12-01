# Use the official Rust image as a base
FROM rust:latest as builder

# Create a working directory
WORKDIR /usr/src/heimdall-api

# Copy your source tree
COPY ./ .

# Build your application
RUN cargo build --release

# Start a new stage for the final image
FROM ubuntu:latest

# Install necessary dependencies including git and cargo
RUN apt-get update && apt-get install -y libssl-dev pkg-config ca-certificates curl strace gdb git cargo && rm -rf /var/lib/apt/lists/*
# Install Rust non-interactively
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y

# Download and install bifrost script
RUN curl -L http://get.heimdall.rs | bash 2>&1 | tee bifrost-install.log

# Source the environment and try running bifrost to install Heimdall
RUN /bin/bash -c "source $HOME/.cargo/env && bifrost -B 2>&1 | tee heimdall-install.log"

# Check if Heimdall is installed correctly
RUN which heimdall || echo "Heimdall not found"

# Copy the build artifact from the build stage
COPY --from=builder /usr/src/heimdall-api/target/release/heimdall_api .

# Expose the port the app runs on
EXPOSE 8080

# Run the binary
CMD ["./heimdall_api"]
