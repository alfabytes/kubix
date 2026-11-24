use std::path::PathBuf;

use kubix::ipc::contract;

fn main() {
    let mut out: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = args.next().map(PathBuf::from),
            "--print" => {
                println!("{}", contract::contract_json());
                return;
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }

    let json = contract::contract_json();
    match out {
        Some(path) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create schema dir");
            }
            std::fs::write(&path, json).expect("write contract.json");
            eprintln!("wrote {}", path.display());
        }
        None => println!("{json}"),
    }
}
