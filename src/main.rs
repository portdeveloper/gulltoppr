use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use log::{error, info};
use serde::Deserialize;
use std::fs;
use std::process::Command;

// Define a struct to hold the chain_id and contract_address path parameters
#[derive(Debug, Deserialize)] // Add Deserialize here
struct AbiPathInfo {
    chain_id: u32,
    contract_address: String,
}

async fn generate_abi(path_info: web::Path<AbiPathInfo>) -> impl Responder {
    let rpc_url = match path_info.chain_id {
        1 => "https://eth.llamarpc.com",
        10 => "https://optimism.llamarpc.com",
        42161 => "https://arbitrum.llamarpc.com",
        8453 => "https://base.llamarpc.com",
        137 => "https://polygon.llamarpc.com",
        100 => "https://1rpc.io/gnosis",
        324 => "https://1rpc.io/zksync2-era",
        534352 => "https://1rpc.io/scroll",
        11155111 => "https://1rpc.io/sepolia",
        5 => "https://rpc.ankr.com/eth_goerli",
        _ => {
            error!("Unsupported chain_id: {}", path_info.chain_id);
            return HttpResponse::BadRequest().body("Unsupported chain_id");
        }
    };

    info!("Generating ABI for: {}", path_info.contract_address);
    let command = format!(
        "heimdall decompile {} --rpc-url {}",
        path_info.contract_address, rpc_url
    );
    info!("Executing command: {}", command);

    let output = Command::new("/root/.bifrost/bin/heimdall")
        .arg("decompile")
        .arg(&path_info.contract_address)
        .arg("--rpc-url")
        .arg(rpc_url)
        .output();

    match output {
        Ok(output) => {
            info!(
                "Command executed. Status: {}, Output: {:?}",
                output.status,
                String::from_utf8_lossy(&output.stdout)
            );
            if output.status.success() {
                info!("ABI generation successful");
                let abi_path = format!(
                    "output/{}/{}/abi.json",
                    path_info.chain_id, path_info.contract_address
                );
                info!("Reading ABI from {}", abi_path);

                match fs::read_to_string(&abi_path) {
                    Ok(abi_content) => HttpResponse::Ok()
                        .content_type("application/json")
                        .body(abi_content),
                    Err(e) => {
                        error!("Failed to read ABI file at {}: {:?}", abi_path, e);
                        HttpResponse::InternalServerError().body("Failed to read ABI file")
                    }
                }
            } else {
                error!(
                    "Error during ABI generation. Stderr: {:?}",
                    String::from_utf8_lossy(&output.stderr)
                );
                HttpResponse::InternalServerError().body("Error generating ABI")
            }
        }
        Err(e) => {
            error!("Failed to execute heimdall command: {:?}", e);
            HttpResponse::InternalServerError().body("Failed to execute command")
        }
    }
}

async fn greet() -> impl Responder {
    "Hello, world!"
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();

    HttpServer::new(|| {
        let cors = Cors::permissive();

        App::new()
            .wrap(cors)
            .route("/", web::get().to(greet))
            .route(
                "/{chain_id}/{contract_address}",
                web::get().to(generate_abi),
            )
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
