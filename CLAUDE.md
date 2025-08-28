# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**gulltoppr** is a streamlined Rust backend service that provides an HTTP API wrapper around [heimdall-rs](https://github.com/Jon-Becker/heimdall-rs), an advanced EVM smart contract toolkit specializing in bytecode analysis and decompilation. The service generates ABIs for smart contracts by decompiling their bytecode.

## Architecture

This is a single-binary Rust application built with:
- **Actix Web**: HTTP server framework handling API endpoints
- **heimdall-rs**: External tool for smart contract bytecode analysis (installed via bifrost installer)
- **Rate limiting**: 2 requests per second, burst size of 5 (via actix-governor)
- **CORS**: Permissive CORS policy for cross-origin requests

### Core Components

- `src/main.rs`: Single source file containing the entire application
  - `generate_abi()`: Main endpoint that executes heimdall decompilation
  - `greet()`: Simple health check endpoint
  - Rate limiting and CORS middleware configuration

### API Endpoints

- `GET /`: Returns "Hello, world!" greeting
- `GET /{contract_address}?rpc_url={rpc_url}`: Generates ABI for given contract address
  - Executes heimdall decompile command against the contract
  - Returns generated ABI JSON or error response
  - Outputs stored in `output/{sanitized_rpc_url}/{contract_address}/` directory

## Development Commands

### Building and Running
```bash
# Build the project
cargo build

# Run in development mode
cargo run

# Build for release
cargo build --release
```

### Docker Commands
```bash
# Build Docker image
docker build -t gulltoppr .

# Run Docker container
docker run -p 8080:8080 gulltoppr
```

### Code Formatting
```bash
# Format code (use for consistent formatting)
cargo fmt

# Check formatting
cargo fmt -- --check
```

## Dependencies

The project uses minimal dependencies focused on web service functionality:
- `actix-web`: Web framework
- `actix-cors`: CORS middleware  
- `actix-governor`: Rate limiting
- `serde`: JSON serialization
- `log` + `env_logger`: Logging
- `time`: Time utilities

## External Tool Integration

The application depends on `heimdall` being available in the system PATH (specifically at `/root/.bifrost/bin/heimdall` in the Docker container). The Dockerfile handles the installation of heimdall via the bifrost installer.

## Deployment

- **Fly.io**: Configured via `fly.toml` for deployment to Fly.io platform
- **Port**: Application runs on port 8080
- **Resource limits**: 1 CPU, 1GB memory as configured in fly.toml

## File Structure

```
├── src/main.rs          # Main application code (single file)
├── Cargo.toml          # Rust dependencies and package config
├── Dockerfile          # Multi-stage Docker build
├── fly.toml           # Fly.io deployment configuration
├── README.md          # Project documentation
└── CONTRIBUTING.md    # Contribution guidelines
```