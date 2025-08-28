FROM rust:latest as builder

WORKDIR /usr/src/heimdall-api

COPY ./ .

RUN cargo build --release

FROM ubuntu:latest

RUN apt-get update && apt-get install -y libssl-dev pkg-config ca-certificates curl git cargo libpq-dev && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y

RUN curl -L http://get.heimdall.rs | bash 2>&1 | tee bifrost-install.log

RUN find / -name bifrost -type f 2>/dev/null

RUN /root/.bifrost/bin/bifrost -B 2>&1 | tee heimdall-install.log || echo "Bifrost execution failed"

RUN cat bifrost-install.log && cat heimdall-install.log

RUN which heimdall || echo "Heimdall not found"

COPY --from=builder /usr/src/heimdall-api/target/release/heimdall_api .

EXPOSE 8080

CMD ["./heimdall_api"]
