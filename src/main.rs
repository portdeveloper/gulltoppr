use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use actix_governor::{Governor, GovernorConfigBuilder};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::process::Command;
use tokio_postgres::{Client, NoTls};

#[derive(Debug, Deserialize)]
struct AbiPathInfo {
    contract_address: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ContractAbi {
    id: Option<i64>,
    contract_address: String,
    rpc_url_hash: String,
    abi_json: serde_json::Value,
    bytecode_hash: Option<String>,
    decompilation_output: Option<String>,
}

struct AppState {
    db_client: Client,
}

async fn generate_abi(
    path_info: web::Path<AbiPathInfo>,
    query: web::Query<HashMap<String, String>>,
    data: web::Data<AppState>,
) -> impl Responder {
    let rpc_url = match query.get("rpc_url") {
        Some(url) => format!("https://{}", url),
        None => {
            error!("Missing rpc_url parameter");
            return HttpResponse::BadRequest().body("Missing rpc_url parameter");
        }
    };

    // Create hash of RPC URL for efficient storage
    let rpc_url_hash = hex::encode(Sha256::digest(rpc_url.as_bytes()));

    // Check if we already have this ABI cached in the database
    let cache_result = data.db_client
        .query(
            "SELECT abi_json FROM contract_abis WHERE contract_address = $1 AND rpc_url_hash = $2",
            &[&path_info.contract_address, &rpc_url_hash],
        )
        .await;

    match cache_result {
        Ok(rows) if !rows.is_empty() => {
            info!("Cache hit for contract: {}", path_info.contract_address);
            let abi_json_str: String = rows[0].get("abi_json");
            return HttpResponse::Ok()
                .content_type("application/json")
                .body(abi_json_str);
        }
        Ok(_) => {
            info!("Cache miss for contract: {}", path_info.contract_address);
        }
        Err(e) => {
            warn!("Database query error: {:?}", e);
        }
    }

    // Create temporary output directory for heimdall
    let temp_dir = format!("temp_output_{}", path_info.contract_address);
    let output_dir = format!(
        "{}/{}",
        temp_dir, path_info.contract_address
    );

    info!("Generating ABI for: {}", path_info.contract_address);
    let command = format!(
        "heimdall decompile {} --rpc-url {} -o {}",
        path_info.contract_address, rpc_url, output_dir
    );
    info!("Executing command: {}", command);

    let output = Command::new("/root/.bifrost/bin/heimdall")
        .arg("decompile")
        .arg(&path_info.contract_address)
        .arg("--rpc-url")
        .arg(rpc_url)
        .arg("-o")
        .arg(&output_dir)
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
                let abi_path = format!("{}/abi.json", output_dir);
                info!("Reading ABI from {}", abi_path);

                match fs::read_to_string(&abi_path) {
                    Ok(abi_content) => {
                        // Validate ABI JSON format
                        if let Err(e) = serde_json::from_str::<serde_json::Value>(&abi_content) {
                            error!("Invalid ABI JSON: {:?}", e);
                            // Clean up temp directory
                            let _ = fs::remove_dir_all(&temp_dir);
                            return HttpResponse::InternalServerError().body("Invalid ABI generated");
                        }

                        // Read full decompilation output if available
                        let decompilation_output = fs::read_to_string(format!("{}/decompiled.sol", output_dir))
                            .ok();

                        // Store in database
                        let insert_result = data.db_client
                            .execute(
                                "INSERT INTO contract_abis (contract_address, rpc_url_hash, abi_json, decompilation_output) 
                                 VALUES ($1, $2, $3, $4) 
                                 ON CONFLICT (contract_address, rpc_url_hash) DO UPDATE SET 
                                 abi_json = EXCLUDED.abi_json, 
                                 decompilation_output = EXCLUDED.decompilation_output,
                                 updated_at = NOW()",
                                &[&path_info.contract_address, &rpc_url_hash, &abi_content, &decompilation_output],
                            )
                            .await;

                        match insert_result {
                            Ok(_) => {
                                info!("Successfully cached ABI for contract: {}", path_info.contract_address);
                            }
                            Err(e) => {
                                warn!("Failed to cache ABI in database: {:?}", e);
                            }
                        }

                        // Clean up temporary directory
                        let _ = fs::remove_dir_all(&temp_dir);

                        HttpResponse::Ok()
                            .content_type("application/json")
                            .body(abi_content)
                    },
                    Err(e) => {
                        error!("Failed to read ABI file at {}: {:?}", abi_path, e);
                        // Clean up temp directory
                        let _ = fs::remove_dir_all(&temp_dir);
                        HttpResponse::InternalServerError().body("Failed to read ABI file")
                    }
                }
            } else {
                error!(
                    "Error during ABI generation. Stderr: {:?}",
                    String::from_utf8_lossy(&output.stderr)
                );
                // Clean up temp directory
                let _ = fs::remove_dir_all(&temp_dir);
                HttpResponse::InternalServerError().body("Error generating ABI")
            }
        }
        Err(e) => {
            error!("Failed to execute heimdall command: {:?}", e);
            // Clean up temp directory
            let _ = fs::remove_dir_all(&temp_dir);
            HttpResponse::InternalServerError().body("Failed to execute command")
        }
    }
}

async fn greet() -> impl Responder {
    "Hello, world!"
}

async fn create_db_connection() -> Result<Client, Box<dyn std::error::Error>> {
    let database_url = env::var("DATABASE_URL")
        .expect("DATABASE_URL environment variable must be set");
    
    let (client, connection) = tokio_postgres::connect(&database_url, NoTls).await?;
    
    // Spawn the connection to run in the background
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            error!("Database connection error: {}", e);
        }
    });
    
    Ok(client)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();
    
    // Create database connection
    let db_client = create_db_connection()
        .await
        .expect("Failed to connect to database");
    
    let app_state = web::Data::new(AppState { db_client });

    let governor_conf = GovernorConfigBuilder::default()
        .per_second(2) 
        .burst_size(5) 
        .finish()
        .unwrap();

    HttpServer::new(move || {
        let cors = Cors::permissive();

        App::new()
            .app_data(app_state.clone())
            .wrap(cors)
            .wrap(Governor::new(&governor_conf))
            .route("/", web::get().to(greet))
            .route("/{contract_address}", web::get().to(generate_abi))
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
