#[path = "../browser_protocol.rs"]
mod browser_protocol;

use browser_protocol::*;
use serde_json::json;
use std::net::{Shutdown, TcpStream};

fn run() -> Result<(), String> {
    let origin = std::env::args().nth(1).ok_or("Missing extension origin")?;
    let config = manifest()?;
    if !config["allowed_origins"]
        .as_array()
        .is_some_and(|origins| origins.iter().any(|item| item == &origin))
    {
        return Err("Extension origin is not registered".into());
    }
    let token = credential()?
        .get_password()
        .map_err(|_| "Start Synapse before connecting the extension")?;
    if !authenticate(
        &json!({"version":1,"token":token,"origin":origin}),
        &token,
        &config["allowed_origins"],
    ) {
        return Err("Invalid native host registration".into());
    }
    let mut socket =
        TcpStream::connect(ADDRESS).map_err(|_| "Synapse is not running or the browser bridge is disabled")?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    socket.set_nodelay(true).map_err(|e| e.to_string())?;
    write_frame(&mut socket, &json!({"version":1,"token":token,"origin":origin}))?;
    let ack = read_frame(&mut socket)?;
    if ack["ok"] != true {
        return Err("Synapse rejected the browser connection".into());
    }
    socket.set_read_timeout(None).map_err(|e| e.to_string())?;
    write_frame(&mut std::io::stdout(), &json!({"version":1,"event":"connected"}))?;
    let mut outgoing = socket.try_clone().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut input = std::io::stdin();
        while let Ok(message) = read_frame(&mut input) {
            if write_frame(&mut outgoing, &message).is_err() {
                break;
            }
        }
        let _ = outgoing.shutdown(Shutdown::Both);
    });
    let mut output = std::io::stdout();
    loop {
        write_frame(&mut output, &read_frame(&mut socket)?)?;
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Synapse browser: {error}");
        let _ = write_frame(
            &mut std::io::stdout(),
            &json!({"version":1,"event":"disconnected","error":error}),
        );
        std::process::exit(1);
    }
}
