# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**gulltoppr** is a streamlined Rust backend service that provides an HTTP API wrapper around [heimdall-rs](https://github.com/Jon-Becker/heimdall-rs), an advanced EVM smart contract toolkit specializing in bytecode analysis and decompilation. The service generates ABIs for smart contracts by decompiling their bytecode.

## Architecture

This is a single-binary Rust application built with:
- **Actix Web**: HTTP server framework handling API endpoints
- **Supabase/PostgreSQL**: Database for caching ABIs and deduplication
- **heimdall-rs**: External tool for smart contract bytecode analysis (installed via bifrost installer)
- **Rate limiting**: 2 requests per second, burst size of 5 (via actix-governor)
- **CORS**: Permissive CORS policy for cross-origin requests

### Core Components

- `src/main.rs`: Single source file containing the entire application
  - `generate_abi()`: Main endpoint with database caching and heimdall decompilation
  - `greet()`: Simple health check endpoint
  - Database connection management and app state
  - Rate limiting and CORS middleware configuration

### Database Schema

The application uses a single table `contract_abis` with:
- `contract_address`: The Ethereum contract address
- `rpc_url_hash`: SHA256 hash of the RPC URL for efficient indexing
- `abi_json`: The generated ABI as JSONB
- `bytecode_hash`: For future deduplication of identical contracts
- `decompilation_output`: Full heimdall decompilation output
- Indexes on `(contract_address, rpc_url_hash)` for fast cache lookups

### API Endpoints

- `GET /`: Returns "Hello, world!" greeting
- `GET /{contract_address}?rpc_url={rpc_url}`: Generates ABI for given contract address
  - **Cache check**: First queries database for existing ABI
  - **Cache hit**: Returns cached ABI immediately
  - **Cache miss**: Executes heimdall decompilation, stores result, returns ABI
  - **Cleanup**: Removes temporary files after database storage

## Development Commands

### Environment Setup

1. **Database Setup**: Create a Supabase project and get your connection string
2. **Environment Variables**: Copy `.env.example` to `.env` and update:
   ```bash
   cp .env.example .env
   # Edit .env with your DATABASE_URL
   ```
3. **Database Schema**: Run the schema setup in your Supabase SQL editor:
   ```bash
   # Copy contents of schema.sql and run in Supabase SQL editor
   ```

### Building and Running
```bash
# Build the project
cargo build

# Run in development mode (requires DATABASE_URL env var)
cargo run

# Build for release
cargo build --release
```

### Docker Commands
```bash
# Build Docker image
docker build -t gulltoppr .

# Run Docker container (requires DATABASE_URL environment variable)
docker run -p 8080:8080 -e DATABASE_URL="your_supabase_url" gulltoppr
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
- `serde` + `serde_json`: JSON serialization
- `log` + `env_logger`: Logging
- `time`: Time utilities
- `tokio-postgres`: PostgreSQL async client for Supabase
- `sha2` + `hex`: Hashing for RPC URL deduplication

## External Tool Integration

The application depends on `heimdall` being available in the system PATH (specifically at `/root/.bifrost/bin/heimdall` in the Docker container). The Dockerfile handles the installation of heimdall via the bifrost installer.

## Deployment

### Fly.io Deployment

1. **Set environment variables**:
   ```bash
   fly secrets set DATABASE_URL="your_supabase_connection_string"
   ```

2. **Deploy**:
   ```bash
   fly deploy
   ```

- **Configuration**: Configured via `fly.toml` for deployment to Fly.io platform
- **Port**: Application runs on port 8080
- **Resource limits**: 1 CPU, 2GB memory (increased from 1GB to handle memory-intensive decompilation)

## File Structure

```
├── src/main.rs          # Main application code (single file)
├── Cargo.toml          # Rust dependencies and package config
├── schema.sql          # Supabase database schema
├── .env.example        # Environment variables template
├── Dockerfile          # Multi-stage Docker build
├── fly.toml           # Fly.io deployment configuration
├── README.md          # Project documentation
└── CONTRIBUTING.md    # Contribution guidelines
```

## Key Improvements

This Supabase integration provides:

1. **Memory Leak Fix**: No more accumulating files - everything is stored in the database
2. **Intelligent Caching**: Instant responses for previously analyzed contracts
3. **Deduplication**: Same contracts on different RPC endpoints share cached results
4. **Persistence**: ABIs are never lost and can be accessed across deployments
5. **Scalability**: Database handles growth better than filesystem storage
6. **Performance**: Fast lookups via database indexes instead of filesystem searches