pub mod cluster;
pub mod config;
pub mod discovery;
pub mod error;
pub mod ipc;
pub mod readonly;
pub mod watch;

#[cfg(feature = "app")]
pub mod app;

#[cfg(feature = "app")]
pub fn run() {
    app::run();
}
