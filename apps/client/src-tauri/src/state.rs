use crate::{docker_discovery::DiscoveredConnection, models::{ConnectionRecord, DatabaseConnection, DatabaseKind, LocalConnectionInput}};
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

pub struct LocalState {
    pub records: Arc<RwLock<Vec<ConnectionRecord>>>,
    pub discovered: Arc<RwLock<HashMap<String, DiscoveredConnection>>>,
    pub pools: Arc<RwLock<HashMap<String, PoolHandle>>>,
    metadata_path: PathBuf,
}

impl LocalState {
    pub fn load(metadata_path: PathBuf) -> Result<Self, String> {
        let records = if metadata_path.exists() { serde_json::from_str(&fs::read_to_string(&metadata_path).map_err(|error| error.to_string())?).map_err(|error| format!("Local connection metadata is invalid: {error}"))? } else { Vec::new() };
        Ok(Self { records: Arc::new(RwLock::new(records)), discovered: Arc::new(RwLock::new(HashMap::new())), pools: Arc::new(RwLock::new(HashMap::new())), metadata_path })
    }
    pub async fn persist(&self) -> Result<(), String> { let records = self.records.read().await; if let Some(parent) = self.metadata_path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; } let temporary = self.metadata_path.with_extension("tmp"); fs::write(&temporary, serde_json::to_vec_pretty(&*records).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?; fs::rename(temporary, &self.metadata_path).map_err(|error| error.to_string()) }
    pub fn store_secret(secret_ref: &str, uri: &str) -> Result<(), String> { Entry::new(KEYRING_SERVICE, secret_ref).map_err(|error| format!("Credential store unavailable: {error}"))?.set_password(uri).map_err(|error| format!("Could not store credential: {error}")) }
    pub fn read_secret(secret_ref: &str) -> Result<String, String> { Entry::new(KEYRING_SERVICE, secret_ref).map_err(|error| format!("Credential store unavailable: {error}"))?.get_password().map_err(|error| format!("Could not read credential: {error}")) }
    pub fn delete_secret(secret_ref: &str) -> Result<(), String> { Entry::new(KEYRING_SERVICE, secret_ref).map_err(|error| format!("Credential store unavailable: {error}"))?.delete_credential().map_err(|error| format!("Could not delete credential: {error}")) }
    pub fn connection_uri(input: &LocalConnectionInput) -> Result<String, String> {
        if let Some(value) = input.connection_string.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            match &input.kind {
                DatabaseKind::Mongodb if !value.starts_with("mongodb://") && !value.starts_with("mongodb+srv://") => return Err("MongoDB connection string must start with mongodb:// or mongodb+srv://.".into()),
                DatabaseKind::Postgres if !value.starts_with("postgres://") && !value.starts_with("postgresql://") => return Err("PostgreSQL connection string must start with postgres:// or postgresql://.".into()),
                DatabaseKind::Mysql if !value.starts_with("mysql://") => return Err("MySQL connection string must start with mysql://.".into()),
                DatabaseKind::Mariadb if !value.starts_with("mysql://") && !value.starts_with("mariadb://") => return Err("MariaDB connection string must start with mysql:// or mariadb://.".into()),
                _ => {}
            }
            Self::database_label(input)?;
            return Ok(if matches!(&input.kind, DatabaseKind::Mariadb) { value.replacen("mariadb://", "mysql://", 1) } else { value.to_string() });
        }
        let scheme = match input.kind { DatabaseKind::Postgres => "postgresql", DatabaseKind::Mysql | DatabaseKind::Mariadb => "mysql", DatabaseKind::Mongodb => "mongodb" };
        let mut uri = Url::parse(&format!("{scheme}://localhost")).map_err(|error| error.to_string())?;
        if !input.username.is_empty() {
            uri.set_username(&input.username).map_err(|_| "Invalid username.".to_string())?;
            uri.set_password(Some(&input.password)).map_err(|_| "Invalid password.".to_string())?;
        }
        uri.set_host(Some(&input.host)).map_err(|_| "Invalid host.".to_string())?;
        uri.set_port(Some(input.port)).map_err(|_| "Invalid port.".to_string())?;
        uri.set_path(&format!("/{}", input.database));
        match input.kind {
            DatabaseKind::Postgres => { uri.query_pairs_mut().append_pair("sslmode", input.ssl_mode.as_deref().unwrap_or(if input.tls { "require" } else { "disable" })); },
            DatabaseKind::Mysql | DatabaseKind::Mariadb => { let mode = match input.ssl_mode.as_deref().unwrap_or(if input.tls { "require" } else { "disable" }) { "disable" => "DISABLED", "prefer" => "PREFERRED", "verify-ca" => "VERIFY_CA", "verify-full" => "VERIFY_IDENTITY", _ => "REQUIRED" }; uri.query_pairs_mut().append_pair("ssl-mode", mode); },
            DatabaseKind::Mongodb => { let mut query = uri.query_pairs_mut(); query.append_pair("tls", if input.tls { "true" } else { "false" }); if let Some(value) = input.auth_source.as_deref().filter(|value| !value.is_empty()) { query.append_pair("authSource", value); } if let Some(value) = input.replica_set.as_deref().filter(|value| !value.is_empty()) { query.append_pair("replicaSet", value); } if let Some(value) = input.direct_connection { query.append_pair("directConnection", if value { "true" } else { "false" }); } },
        };
        if let Some(timeout) = input.connect_timeout_ms { uri.query_pairs_mut().append_pair(if matches!(&input.kind, DatabaseKind::Mongodb) { "connectTimeoutMS" } else { "connect_timeout" }, &if matches!(&input.kind, DatabaseKind::Mongodb) { timeout.to_string() } else { (timeout / 1_000).max(1).to_string() }); }
        Ok(uri.to_string())
    }
    pub fn database_label(input: &LocalConnectionInput) -> Result<String, String> {
        if matches!(&input.kind, DatabaseKind::Mongodb) { return Ok("All databases".into()); }
        if let Some(value) = input.connection_string.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            let parsed = Url::parse(value).map_err(|_| "The connection string is invalid.".to_string())?;
            let encoded = parsed.path().trim_start_matches('/');
            if encoded.is_empty() { return Err("The connection string must include a database name.".into()); }
            return percent_decode_str(encoded).decode_utf8().map(String::from).map_err(|_| "The database name is invalid.".to_string());
        }
        Ok(input.database.clone())
    }
    pub fn connection_timeout(uri: &str) -> Duration {
        let Some(parsed) = Url::parse(uri).ok() else { return Duration::from_secs(5); };
        let milliseconds = parsed.query_pairs().find_map(|(key, value)| match key.as_ref() {
            "connectTimeoutMS" | "connectTimeout" => value.parse::<u64>().ok(),
            "connect_timeout" => value.parse::<u64>().ok().map(|seconds| seconds.saturating_mul(1_000)),
            _ => None,
        }).unwrap_or(5_000).clamp(1_000, 120_000);
        Duration::from_millis(milliseconds)
    }
    pub async fn connect(kind: &DatabaseKind, uri: &str, _database: &str) -> Result<PoolHandle, String> { let connect_timeout = Self::connection_timeout(uri); match kind { DatabaseKind::Postgres => { let pool = PgPoolOptions::new().max_connections(5).min_connections(0).acquire_timeout(connect_timeout).idle_timeout(Duration::from_secs(30)).after_connect(|connection, _| Box::pin(async move { sqlx::query("SET default_transaction_read_only = on").execute(connection).await?; Ok(()) })).connect(uri).await.map_err(|error| format!("PostgreSQL connection failed: {error}"))?; Ok(PoolHandle::Postgres(pool)) }, DatabaseKind::Mysql | DatabaseKind::Mariadb => { let pool = MySqlPoolOptions::new().max_connections(5).min_connections(0).acquire_timeout(connect_timeout).idle_timeout(Duration::from_secs(30)).after_connect(|connection, _| Box::pin(async move { sqlx::query("SET SESSION TRANSACTION READ ONLY").execute(connection).await?; Ok(()) })).connect(uri).await.map_err(|error| format!("MySQL-compatible connection failed: {error}"))?; Ok(PoolHandle::Mysql(pool)) }, DatabaseKind::Mongodb => { let mut options = ClientOptions::parse(uri).await.map_err(|error| format!("MongoDB connection failed: {error}"))?; options.max_pool_size = Some(5); options.min_pool_size = Some(0); options.server_selection_timeout = Some(connect_timeout); let client = Client::with_options(options).map_err(|error| error.to_string())?; client.database("admin").run_command(doc! { "ping": 1 }).await.map_err(|error| format!("MongoDB connection failed: {error}"))?; Ok(PoolHandle::Mongodb(client)) } } }
    pub async fn all_connections(&self) -> Vec<DatabaseConnection> {
        let records = self.records.read().await;
        let pinned_containers = records.iter().filter_map(|record| record.public.source.as_ref().map(|source| source.container_id.as_str())).collect::<Vec<_>>();
        let mut connections = records.iter().map(|record| record.public.clone()).collect::<Vec<_>>();
        let mut discovered = self.discovered.read().await.values()
            .filter(|record| record.public.source.as_ref().is_none_or(|source| !pinned_containers.contains(&source.container_id.as_str())))
            .map(|record| record.public.clone()).collect::<Vec<_>>();
        discovered.sort_by(|left, right| {
            left.source.as_ref().map(|source| source.project.as_str()).cmp(&right.source.as_ref().map(|source| source.project.as_str()))
                .then_with(|| left.name.cmp(&right.name))
        });
        connections.extend(discovered);
        connections
    }
    pub async fn connection_record(&self, id: &str) -> Result<ConnectionRecord, String> {
        if let Some(record) = self.records.read().await.iter().find(|record| record.public.id == id).cloned() {
            return Ok(record);
        }
        self.discovered.read().await.get(id).map(|record| ConnectionRecord { public: record.public.clone(), secret_ref: String::new() }).ok_or_else(|| "Local connection not found.".to_string())
    }
    pub async fn replace_discovered(&self, records: Vec<DiscoveredConnection>) {
        let next = records.into_iter().map(|record| (record.public.id.clone(), record)).collect::<HashMap<_, _>>();
        let changed = {
            let current = self.discovered.read().await;
            current.iter().filter_map(|(id, record)| match next.get(id) {
                Some(next_record) if next_record.uri == record.uri => None,
                _ => Some(id.clone()),
            }).collect::<Vec<_>>()
        };
        *self.discovered.write().await = next;
        for id in changed {
            self.close_pool(&id).await;
        }
    }
    pub async fn pool_for(&self, record: &ConnectionRecord) -> Result<PoolHandle, String> {
        if let Some(pool) = self.pools.read().await.get(&record.public.id).cloned() { return Ok(pool); }
        let uri = if let Some(record) = self.discovered.read().await.get(&record.public.id) { record.uri.clone() } else { Self::read_secret(&record.secret_ref)? };
        let pool = Self::connect(&record.public.kind, &uri, &record.public.database).await?;
        self.pools.write().await.insert(record.public.id.clone(), pool.clone());
        Ok(pool)
    }
    pub async fn close_pool(&self, id: &str) { if let Some(pool) = self.pools.write().await.remove(id) { match pool { PoolHandle::Postgres(pool) => pool.close().await, PoolHandle::Mysql(pool) => pool.close().await, PoolHandle::Mongodb(_) => {} } } }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn postgres_input(connection_string: &str) -> LocalConnectionInput { LocalConnectionInput { name: "Hosted Postgres".into(), kind: DatabaseKind::Postgres, environment: "production".into(), host: "".into(), port: 0, database: "".into(), username: "".into(), password: "".into(), tls: true, connection_string: Some(connection_string.into()), ssl_mode: None, auth_source: None, replica_set: None, direct_connection: None, connect_timeout_ms: None } }

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

    #[test]
    fn accepts_mariadb_urls_through_the_mysql_driver() {
        let mut input = postgres_input("mariadb://reader:secret@localhost:3306/app");
        input.kind = DatabaseKind::Mariadb;
        assert_eq!(LocalState::connection_uri(&input).unwrap(), "mysql://reader:secret@localhost:3306/app");
        assert_eq!(LocalState::database_label(&input).unwrap(), "app");
    }

    #[test]
    fn builds_passwordless_mongo_urls_with_advanced_options() {
        let input = LocalConnectionInput { name: "Local Mongo".into(), kind: DatabaseKind::Mongodb, environment: "development".into(), host: "localhost".into(), port: 27017, database: "".into(), username: "".into(), password: "".into(), tls: false, connection_string: None, ssl_mode: None, auth_source: Some("admin".into()), replica_set: Some("rs0".into()), direct_connection: Some(true), connect_timeout_ms: Some(12_000) };
        let uri = Url::parse(&LocalState::connection_uri(&input).unwrap()).unwrap();
        assert!(uri.username().is_empty());
        assert_eq!(uri.query_pairs().find(|(key, _)| key == "authSource").unwrap().1, "admin");
        assert_eq!(uri.query_pairs().find(|(key, _)| key == "replicaSet").unwrap().1, "rs0");
        assert_eq!(uri.query_pairs().find(|(key, _)| key == "directConnection").unwrap().1, "true");
        assert_eq!(uri.query_pairs().find(|(key, _)| key == "connectTimeoutMS").unwrap().1, "12000");
        assert_eq!(LocalState::connection_timeout(uri.as_str()), Duration::from_secs(12));
        assert_eq!(LocalState::database_label(&input).unwrap(), "All databases");
    }
}
