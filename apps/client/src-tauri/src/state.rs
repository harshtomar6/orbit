use crate::models::{ConnectionRecord, DatabaseKind, LocalConnectionInput};
use keyring::Entry;
use mongodb::{bson::doc, options::ClientOptions, Client};
use percent_encoding::percent_decode_str;
use sqlx::{mysql::MySqlPoolOptions, postgres::PgPoolOptions, MySqlPool, PgPool};
use std::{collections::HashMap, fs, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::RwLock;
use url::Url;

const KEYRING_SERVICE: &str = "com.orbit.data.local-connections";

#[derive(Clone)]
pub enum PoolHandle { Postgres(PgPool), Mysql(MySqlPool), Mongodb(Client) }

pub struct LocalState { pub records: Arc<RwLock<Vec<ConnectionRecord>>>, pub pools: Arc<RwLock<HashMap<String, PoolHandle>>>, metadata_path: PathBuf }

impl LocalState {
    pub fn load(metadata_path: PathBuf) -> Result<Self, String> {
        let records = if metadata_path.exists() { serde_json::from_str(&fs::read_to_string(&metadata_path).map_err(|error| error.to_string())?).map_err(|error| format!("Local connection metadata is invalid: {error}"))? } else { Vec::new() };
        Ok(Self { records: Arc::new(RwLock::new(records)), pools: Arc::new(RwLock::new(HashMap::new())), metadata_path })
    }
    pub async fn persist(&self) -> Result<(), String> { let records = self.records.read().await; if let Some(parent) = self.metadata_path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; } let temporary = self.metadata_path.with_extension("tmp"); fs::write(&temporary, serde_json::to_vec_pretty(&*records).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?; fs::rename(temporary, &self.metadata_path).map_err(|error| error.to_string()) }
    pub fn store_secret(secret_ref: &str, uri: &str) -> Result<(), String> { Entry::new(KEYRING_SERVICE, secret_ref).map_err(|error| format!("Credential store unavailable: {error}"))?.set_password(uri).map_err(|error| format!("Could not store credential: {error}")) }
    pub fn read_secret(secret_ref: &str) -> Result<String, String> { Entry::new(KEYRING_SERVICE, secret_ref).map_err(|error| format!("Credential store unavailable: {error}"))?.get_password().map_err(|error| format!("Could not read credential: {error}")) }
    pub fn delete_secret(secret_ref: &str) -> Result<(), String> { Entry::new(KEYRING_SERVICE, secret_ref).map_err(|error| format!("Credential store unavailable: {error}"))?.delete_credential().map_err(|error| format!("Could not delete credential: {error}")) }
    pub fn connection_uri(input: &LocalConnectionInput) -> Result<String, String> {
        if matches!(&input.kind, DatabaseKind::Mongodb | DatabaseKind::Postgres) {
            if let Some(value) = input.connection_string.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                match &input.kind {
                    DatabaseKind::Mongodb if !value.starts_with("mongodb://") && !value.starts_with("mongodb+srv://") => return Err("MongoDB connection string must start with mongodb:// or mongodb+srv://.".into()),
                    DatabaseKind::Postgres if !value.starts_with("postgres://") && !value.starts_with("postgresql://") => return Err("PostgreSQL connection string must start with postgres:// or postgresql://.".into()),
                    _ => {}
                }
                if matches!(&input.kind, DatabaseKind::Postgres) { Self::database_label(input)?; }
                return Ok(value.to_string());
            }
        }
        let scheme = match input.kind { DatabaseKind::Postgres => "postgresql", DatabaseKind::Mysql => "mysql", DatabaseKind::Mongodb => "mongodb" };
        let mut uri = Url::parse(&format!("{scheme}://localhost")).map_err(|error| error.to_string())?;
        uri.set_username(&input.username).map_err(|_| "Invalid username.".to_string())?;
        uri.set_password(Some(&input.password)).map_err(|_| "Invalid password.".to_string())?;
        uri.set_host(Some(&input.host)).map_err(|_| "Invalid host.".to_string())?;
        uri.set_port(Some(input.port)).map_err(|_| "Invalid port.".to_string())?;
        uri.set_path(&format!("/{}", input.database));
        match input.kind { DatabaseKind::Postgres => uri.query_pairs_mut().append_pair("sslmode", if input.tls { "require" } else { "disable" }), DatabaseKind::Mysql => uri.query_pairs_mut().append_pair("ssl-mode", if input.tls { "REQUIRED" } else { "DISABLED" }), DatabaseKind::Mongodb => uri.query_pairs_mut().append_pair("tls", if input.tls { "true" } else { "false" }) };
        Ok(uri.to_string())
    }
    pub fn database_label(input: &LocalConnectionInput) -> Result<String, String> {
        if matches!(&input.kind, DatabaseKind::Mongodb) { return Ok("All databases".into()); }
        if matches!(&input.kind, DatabaseKind::Postgres) {
            if let Some(value) = input.connection_string.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                let parsed = Url::parse(value).map_err(|_| "PostgreSQL connection string is invalid.".to_string())?;
                if parsed.scheme() != "postgres" && parsed.scheme() != "postgresql" { return Err("PostgreSQL connection string must start with postgres:// or postgresql://.".into()); }
                let encoded = parsed.path().trim_start_matches('/');
                if encoded.is_empty() { return Err("The PostgreSQL connection string must include a database name.".into()); }
                return percent_decode_str(encoded).decode_utf8().map(String::from).map_err(|_| "The PostgreSQL database name is invalid.".to_string());
            }
        }
        Ok(input.database.clone())
    }
    pub async fn connect(kind: &DatabaseKind, uri: &str, _database: &str) -> Result<PoolHandle, String> { match kind { DatabaseKind::Postgres => { let pool = PgPoolOptions::new().max_connections(5).min_connections(0).acquire_timeout(Duration::from_secs(5)).idle_timeout(Duration::from_secs(30)).after_connect(|connection, _| Box::pin(async move { sqlx::query("SET default_transaction_read_only = on").execute(connection).await?; Ok(()) })).connect(uri).await.map_err(|error| format!("PostgreSQL connection failed: {error}"))?; Ok(PoolHandle::Postgres(pool)) }, DatabaseKind::Mysql => { let pool = MySqlPoolOptions::new().max_connections(5).min_connections(0).acquire_timeout(Duration::from_secs(5)).idle_timeout(Duration::from_secs(30)).after_connect(|connection, _| Box::pin(async move { sqlx::query("SET SESSION TRANSACTION READ ONLY").execute(connection).await?; Ok(()) })).connect(uri).await.map_err(|error| format!("MySQL connection failed: {error}"))?; Ok(PoolHandle::Mysql(pool)) }, DatabaseKind::Mongodb => { let mut options = ClientOptions::parse(uri).await.map_err(|error| format!("MongoDB connection failed: {error}"))?; options.max_pool_size = Some(5); options.min_pool_size = Some(0); options.server_selection_timeout = Some(Duration::from_secs(5)); let client = Client::with_options(options).map_err(|error| error.to_string())?; client.database("admin").run_command(doc! { "ping": 1 }).await.map_err(|error| format!("MongoDB connection failed: {error}"))?; Ok(PoolHandle::Mongodb(client)) } } }
    pub async fn pool_for(&self, record: &ConnectionRecord) -> Result<PoolHandle, String> { if let Some(pool) = self.pools.read().await.get(&record.public.id).cloned() { return Ok(pool); } let uri = Self::read_secret(&record.secret_ref)?; let pool = Self::connect(&record.public.kind, &uri, &record.public.database).await?; self.pools.write().await.insert(record.public.id.clone(), pool.clone()); Ok(pool) }
    pub async fn close_pool(&self, id: &str) { if let Some(pool) = self.pools.write().await.remove(id) { match pool { PoolHandle::Postgres(pool) => pool.close().await, PoolHandle::Mysql(pool) => pool.close().await, PoolHandle::Mongodb(_) => {} } } }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn postgres_input(connection_string: &str) -> LocalConnectionInput { LocalConnectionInput { name: "Hosted Postgres".into(), kind: DatabaseKind::Postgres, environment: "production".into(), host: "".into(), port: 0, database: "".into(), username: "".into(), password: "".into(), tls: true, connection_string: Some(connection_string.into()) } }

    #[test]
    fn preserves_postgres_connection_strings_and_reads_the_database() {
        let input = postgres_input("postgresql://reader:secret@db.example.com:5432/product%20analytics?sslmode=verify-full");
        assert_eq!(LocalState::connection_uri(&input).unwrap(), input.connection_string.unwrap());
        let input = postgres_input("postgresql://reader:secret@db.example.com:5432/product%20analytics?sslmode=verify-full");
        assert_eq!(LocalState::database_label(&input).unwrap(), "product analytics");
    }

    #[test]
    fn rejects_postgres_connection_strings_without_a_database() {
        assert!(LocalState::connection_uri(&postgres_input("postgresql://reader:secret@localhost:5432")).unwrap_err().contains("database name"));
    }
}
