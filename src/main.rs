use actix_web::{web, App, HttpServer, Responder};

async fn greet() -> impl Responder {
    "Hello, world!"
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| App::new().route("/", web::get().to(greet)))
        .bind("127.0.0.1:8080")?
        .run()
        .await
}
