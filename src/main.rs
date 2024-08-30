use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use actix_governor::{Governor, GovernorConfigBuilder};
use log::{error, info};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::process::Command;

#[derive(Debug, Deserialize)]
struct AbiPathInfo {
    contract_address: String,
}

async fn generate_abi(
    path_info: web::Path<AbiPathInfo>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let rpc_url = match query.get("rpc_url") {
        Some(url) => format!("https://{}", url),
        None => {
            error!("Missing rpc_url parameter");
            return HttpResponse::BadRequest().body("Missing rpc_url parameter");
        }
    };

    let sanitized_rpc_url = rpc_url.replace("https://", "").replace("/", "_");
    let output_dir = format!(
        "output/{}/{}",
        sanitized_rpc_url, path_info.contract_address
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

    let governor_conf = GovernorConfigBuilder::default()
        .per_second(2) 
        .burst_size(5) 
        .finish()
        .unwrap();

    HttpServer::new(move || {
        let cors = Cors::permissive();

        App::new()
            .wrap(cors)
            .wrap(Governor::new(&governor_conf))
            .route("/", web::get().to(greet))
            .route("/{contract_address}", web::get().to(generate_abi))
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
