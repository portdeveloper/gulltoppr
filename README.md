# 🐎 gulltoppr

🧪 `gulltoppr` is a streamlined, efficient backend service designed for `heimdall-rs`, an advanced EVM smart contract toolkit specializing in bytecode analysis.

Check out the amazing tool that made this little project possible:

- [heimdall-rs](https://github.com/Jon-Becker/heimdall-rs)

⚙️ Built using Rust and Actix.

- ✅ **Efficient Processing**: Optimized for fast and accurate handling of smart contract bytecode analysis.
- 🔗 **Rust Backend**: Leverages Rust's performance and safety features.

## Requirements

Before you begin, ensure you have Rust and Docker installed on your system:

- [Rust](https://www.rust-lang.org/tools/install)
- [Docker](https://docs.docker.com/get-docker/)

## Quickstart

To get started with `gulltoppr`, follow these steps:

1. Clone this repo & install dependencies:

   ```sh
   git clone https://github.com/portdeveloper/gulltoppr.git
   cd gulltoppr
   cargo build
   ```

2. Run the server:

   ```sh
   cargo run
   ```

   This command starts the gulltoppr backend server. The server runs on your local machine and interfaces with heimdall-rs for bytecode analysis.

### Docker Quickstart

1. Build the Docker image:

   ```sh
   docker build -t gulltoppr .
   ```

2. Run the Docker container:

   ```sh
    docker run -p 8080:8080 gulltoppr
   ```

   This command starts the gulltoppr backend server in a Docker container. The server runs on your local machine and interfaces with heimdall-rs for bytecode analysis.

## Endpoints

### Greet Endpoint

- **URL**: `/`
- **Method**: `GET`
- **Description**: Returns a greeting message.
- **Example**: `curl http://localhost:8080/`

### Generate ABI Endpoint

- **URL**: `/{contract_address}`
- **Method**: `GET`
- **Description**: Generates the ABI for the specified contract address using the provided RPC URL.
- **Query Parameters**:
  - `rpc_url`: The RPC URL without the https:// prefix.
- **Example**: `curl http://localhost:8080/0x1234567890abcdef1234567890abcdef12345678?rpc_url=eth.llamarpc.com`

This request will generate the ABI for the specified contract address using the provided RPC URL and return it back to you in the response.

