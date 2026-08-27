mod commands;
mod models;
mod state;

use state::LocalState;
use tauri::Manager;

#[tauri::command]
fn platform_name() -> &'static str {
    std::env::consts::OS
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("local-connections.json");
            app.manage(LocalState::load(path).map_err(std::io::Error::other)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform_name,
            commands::local_list_connections,
            commands::local_create_connection,
            commands::local_update_connection,
            commands::local_remove_connection,
            commands::local_test_connection,
            commands::local_list_objects,
            commands::local_list_namespace_objects,
            commands::local_explore,
            commands::local_count_documents,
            commands::local_resolve_reference
        ])
        .run(tauri::generate_context!())
        .expect("error while running Orbit");
}
