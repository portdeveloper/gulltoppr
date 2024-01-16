# Builder stage for Rust application
FROM rust:slim as rust-builder

WORKDIR /usr/src/heimdall-api
COPY ./ .
RUN cargo build --release && \
    strip /usr/src/heimdall-api/target/release/heimdall_api && \
    chmod +x /usr/src/heimdall-api/target/release/heimdall_api

# Intermediate stage for Bifrost (and Heimdall) installation
FROM ubuntu:latest as bifrost-installer

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git cargo && \
    rm -rf /var/lib/apt/lists/* 

RUN curl -L http://get.heimdall.rs | bash 2>&1 | tee bifrost-install.log
RUN /root/.bifrost/bin/bifrost -B 2>&1 | tee heimdall-install.log || echo "Bifrost execution failed"

# Final image stage
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl-dev \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=rust-builder /usr/src/heimdall-api/target/release/heimdall_api /usr/local/bin/

EXPOSE 8080
CMD ["heimdall_api"]
