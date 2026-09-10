use crate::models::{DatabaseConnection, DatabaseKind, DockerConnectionSource};
use serde::Deserialize;
use std::{collections::HashMap, path::{Path, PathBuf}, time::Duration};
use tokio::{process::Command, time::timeout};
use url::Url;

const DOCKER_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone)]
pub struct DiscoveredConnection {
    pub public: DatabaseConnection,
    pub uri: String,
}

#[derive(Debug, Deserialize)]
struct DockerInspect {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Config")]
    config: DockerConfig,
    #[serde(rename = "State")]
    state: DockerState,
    #[serde(rename = "NetworkSettings")]
    network_settings: DockerNetworkSettings,
}

#[derive(Debug, Deserialize)]
struct DockerConfig {
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "Env", default)]
    env: Vec<String>,
    #[serde(rename = "Labels", default)]
    labels: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct DockerState {
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Health")]
    health: Option<DockerHealth>,
}

#[derive(Debug, Deserialize)]
struct DockerHealth {
    #[serde(rename = "Status", default)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct DockerNetworkSettings {
    #[serde(rename = "Ports", default)]
    ports: HashMap<String, Option<Vec<DockerPortBinding>>>,
}

#[derive(Debug, Deserialize)]
struct DockerPortBinding {
    #[serde(rename = "HostIp", default)]
    host_ip: String,
    #[serde(rename = "HostPort", default)]
    host_port: String,
}

pub async fn discover() -> Result<Vec<DiscoveredConnection>, String> {
    let ids = run_docker(&["ps", "--filter", "status=running", "--format", "{{.ID}}"])
        .await?;
    let ids = ids.lines().map(str::trim).filter(|id| !id.is_empty()).collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut arguments = vec!["inspect"];
    arguments.extend(ids);
    let output = run_docker(&arguments).await?;
    let containers: Vec<DockerInspect> = serde_json::from_str(&output)
        .map_err(|error| format!("Docker returned invalid container metadata: {error}"))?;
    Ok(discover_from_inspects(containers))
}

async fn run_docker(arguments: &[&str]) -> Result<String, String> {
    let output = timeout(DOCKER_TIMEOUT, Command::new(docker_executable()).args(arguments).output())
        .await
        .map_err(|_| "Docker discovery timed out.".to_string())?
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "Docker CLI is not installed or not available to Orbit.".to_string(),
            _ => format!("Docker discovery could not start: {error}"),
        })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Docker is unavailable: {}", detail.trim()));
    }
    String::from_utf8(output.stdout).map_err(|_| "Docker returned non-UTF-8 output.".to_string())
}

fn docker_executable() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        for candidate in [
            PathBuf::from("/usr/local/bin/docker"),
            PathBuf::from("/opt/homebrew/bin/docker"),
            PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker"),
        ] {
            if candidate.is_file() {
                return candidate;
            }
        }
        if let Some(candidate) = std::env::var_os("HOME").map(PathBuf::from).map(|home| home.join(".docker/bin/docker")) {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("docker")
}

fn discover_from_inspects(containers: Vec<DockerInspect>) -> Vec<DiscoveredConnection> {
    let mut connections = containers.into_iter().filter_map(connection_from_inspect).collect::<Vec<_>>();
    connections.sort_by(|left, right| {
        let left_source = left.public.source.as_ref();
        let right_source = right.public.source.as_ref();
        left_source.map(|source| source.project.as_str()).cmp(&right_source.map(|source| source.project.as_str()))
            .then_with(|| left.public.name.cmp(&right.public.name))
    });
    connections
}

fn connection_from_inspect(container: DockerInspect) -> Option<DiscoveredConnection> {
    if container.state.status != "running" {
        return None;
    }
    let image = container.config.image.to_ascii_lowercase();
    let kind = if image.contains("postgres") {
        DatabaseKind::Postgres
    } else if image.contains("mongo") {
        DatabaseKind::Mongodb
    } else if image.contains("mariadb") {
        DatabaseKind::Mariadb
    } else if image.contains("mysql") {
        DatabaseKind::Mysql
    } else if container.network_settings.ports.contains_key("5432/tcp") {
        DatabaseKind::Postgres
    } else if container.network_settings.ports.contains_key("27017/tcp") {
        DatabaseKind::Mongodb
    } else if container.network_settings.ports.contains_key("3306/tcp") {
        DatabaseKind::Mysql
    } else {
        return None;
    };

    let container_port = match kind {
        DatabaseKind::Postgres => "5432/tcp",
        DatabaseKind::Mysql | DatabaseKind::Mariadb => "3306/tcp",
        DatabaseKind::Mongodb => "27017/tcp",
    };
    let host_port = local_host_port(&container.network_settings.ports, container_port)?;
    let environment = environment_map(&container.config.env);
    let (uri, database) = connection_uri(&kind, host_port, &environment)?;
    let container_name = container.name.trim_start_matches('/').to_string();
    let service = container.config.labels.get("com.docker.compose.service").cloned();
    let project = container.config.labels.get("com.docker.compose.project").cloned()
        .or_else(|| container.config.labels.get("com.docker.compose.project.working_dir").and_then(|value| Path::new(value).file_name()).map(|value| value.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Docker".to_string());
    let health = container.state.health.as_ref().map(|value| value.status.as_str()).unwrap_or("running").to_string();
    let status = match health.as_str() {
        "unhealthy" => "unavailable",
        "starting" => "checking",
        _ => "healthy",
    };
    let public = DatabaseConnection {
        id: format!("docker_{}", container.id),
        name: service.clone().unwrap_or_else(|| container_name.clone()),
        kind,
        environment: "development".to_string(),
        database,
        read_only: true,
        status: status.to_string(),
        latency_ms: None,
        last_schema_refresh: None,
        access_level: "read_only".to_string(),
        local: true,
        ephemeral: Some(true),
        source: Some(DockerConnectionSource {
            kind: "docker".to_string(),
            container_id: container.id,
            container_name,
            image: container.config.image,
            project,
            service,
            health,
        }),
    };
    Some(DiscoveredConnection { public, uri })
}

fn local_host_port(ports: &HashMap<String, Option<Vec<DockerPortBinding>>>, container_port: &str) -> Option<u16> {
    ports.get(container_port)?.as_ref()?.iter()
        .find(|binding| matches!(binding.host_ip.as_str(), "" | "0.0.0.0" | "127.0.0.1" | "::" | "::1"))?
        .host_port.parse().ok()
}

fn environment_map(values: &[String]) -> HashMap<&str, &str> {
    values.iter().filter_map(|value| value.split_once('=')).collect()
}

fn connection_uri(kind: &DatabaseKind, port: u16, environment: &HashMap<&str, &str>) -> Option<(String, String)> {
    match kind {
        DatabaseKind::Postgres => {
            let username = environment.get("POSTGRES_USER").copied().unwrap_or("postgres");
            let database = environment.get("POSTGRES_DB").copied().unwrap_or(username).to_string();
            let password = environment.get("POSTGRES_PASSWORD").copied();
            if password.is_none() && environment.get("POSTGRES_HOST_AUTH_METHOD").copied() != Some("trust") {
                return None;
            }
            Some((build_uri("postgresql", username, password, port, &database, &[("sslmode", "disable")])?, database))
        }
        DatabaseKind::Mysql | DatabaseKind::Mariadb => {
            let username = environment.get("MYSQL_USER").copied().filter(|value| !value.is_empty()).unwrap_or("root");
            let password = if username == "root" { environment.get("MYSQL_ROOT_PASSWORD").copied() } else { environment.get("MYSQL_PASSWORD").copied() };
            let permits_empty_password = environment.get("MYSQL_ALLOW_EMPTY_PASSWORD").is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
            if password.is_none() && !permits_empty_password {
                return None;
            }
            let database = environment.get("MYSQL_DATABASE").copied().unwrap_or("mysql").to_string();
            Some((build_uri("mysql", username, password, port, &database, &[("ssl-mode", "DISABLED")])?, database))
        }
        DatabaseKind::Mongodb => {
            let username = environment.get("MONGO_INITDB_ROOT_USERNAME").copied().unwrap_or("");
            let password = environment.get("MONGO_INITDB_ROOT_PASSWORD").copied();
            if !username.is_empty() && password.is_none() {
                return None;
            }
            let query = if username.is_empty() { vec![("tls", "false")] } else { vec![("authSource", "admin"), ("tls", "false")] };
            Some((build_uri("mongodb", username, password, port, "", &query)?, "All databases".to_string()))
        }
    }
}

fn build_uri(scheme: &str, username: &str, password: Option<&str>, port: u16, database: &str, query: &[(&str, &str)]) -> Option<String> {
    let mut uri = Url::parse(&format!("{scheme}://127.0.0.1")).ok()?;
    if !username.is_empty() {
        uri.set_username(username).ok()?;
        if let Some(password) = password {
            uri.set_password(Some(password)).ok()?;
        }
    }
    uri.set_port(Some(port)).ok()?;
    uri.set_path(&format!("/{database}"));
    uri.query_pairs_mut().extend_pairs(query.iter().copied());
    Some(uri.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspect(image: &str, env: &[&str], port: &str, host_port: &str) -> DockerInspect {
        DockerInspect {
            id: "abcdef1234567890".into(),
            name: "/orbit-db".into(),
            config: DockerConfig {
                image: image.into(),
                env: env.iter().map(|value| value.to_string()).collect(),
                labels: HashMap::from([
                    ("com.docker.compose.project".into(), "sample-app".into()),
                    ("com.docker.compose.service".into(), "database".into()),
                ]),
            },
            state: DockerState { status: "running".into(), health: Some(DockerHealth { status: "healthy".into() }) },
            network_settings: DockerNetworkSettings { ports: HashMap::from([(port.into(), Some(vec![DockerPortBinding { host_ip: "0.0.0.0".into(), host_port: host_port.into() }]))]) },
        }
    }

    #[test]
    fn discovers_compose_postgres_with_safe_public_metadata() {
        let item = connection_from_inspect(inspect("postgres:17", &["POSTGRES_USER=app", "POSTGRES_PASSWORD=secret", "POSTGRES_DB=product"], "5432/tcp", "55432")).unwrap();
        assert_eq!(item.public.name, "database");
        assert_eq!(item.public.database, "product");
        assert_eq!(item.public.source.as_ref().unwrap().project, "sample-app");
        assert!(item.uri.contains("secret"));
        assert!(!serde_json::to_string(&item.public).unwrap().contains("secret"));
    }

    #[test]
    fn discovers_passwordless_mongo_and_marks_it_ephemeral() {
        let item = connection_from_inspect(inspect("mongo:8", &[], "27017/tcp", "27018")).unwrap();
        assert_eq!(item.public.kind, DatabaseKind::Mongodb);
        assert_eq!(item.public.database, "All databases");
        assert_eq!(item.public.ephemeral, Some(true));
        assert!(item.uri.starts_with("mongodb://127.0.0.1:27018/"));
    }

    #[test]
    fn ignores_databases_without_a_local_port_binding() {
        let mut container = inspect("postgres:17", &["POSTGRES_PASSWORD=secret"], "5432/tcp", "5432");
        container.network_settings.ports.insert("5432/tcp".into(), None);
        assert!(connection_from_inspect(container).is_none());
    }
}
