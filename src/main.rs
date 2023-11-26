use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use log::{error, info};
use std::fs;
use std::process::Command;

async fn generate_abi(contract_address: web::Path<String>) -> impl Responder {
    info!("Generating ABI for: {}", contract_address);

    let output = Command::new("heimdall")
        .arg("decompile")
        .arg(&*contract_address)
        .arg("--rpc-url")
        .arg("https://eth.llamarpc.com")
        .output();

    match output {
        Ok(output) => {
            if output.status.success() {
                info!("ABI generation successful");
                let abi_path = format!("output/{}/abi.json", contract_address);

                match fs::read_to_string(&abi_path) {
                    Ok(abi_content) => HttpResponse::Ok()
                        .content_type("application/json")
                        .body(abi_content),
                    Err(e) => {
                        error!("Failed to read ABI file: {:?}", e);
                        HttpResponse::InternalServerError().body("Failed to read ABI file")
                    }
                }
            } else {
                error!("Error during ABI generation: {:?}", output.stderr);
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
                "/generate-abi/{contract_address}",
                web::get().to(generate_abi),
            )
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
