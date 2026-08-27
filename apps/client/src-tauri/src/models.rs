use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseKind { Postgres, Mysql, Mongodb }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConnectionInput { pub name: String, pub kind: DatabaseKind, pub environment: String, pub host: String, pub port: u16, pub database: String, pub username: String, pub password: String, pub tls: bool, pub connection_string: Option<String> }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConnection { pub id: String, pub name: String, pub kind: DatabaseKind, pub environment: String, pub database: String, pub read_only: bool, pub status: String, pub latency_ms: Option<u64>, pub last_schema_refresh: Option<String>, pub access_level: String, pub local: bool }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRecord { pub public: DatabaseConnection, pub secret_ref: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataObject { pub connection_id: String, pub namespace: String, pub name: String, pub kind: String, #[serde(skip_serializing_if = "Option::is_none")] pub estimated_rows: Option<u64> }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataColumnReference { pub namespace: String, pub object: String, pub column: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataColumn { pub name: String, pub native_type: String, pub nullable: bool, pub primary_key: Option<bool>, #[serde(skip_serializing_if = "Option::is_none")] pub reference: Option<DataColumnReference>, #[serde(skip_serializing_if = "Option::is_none")] pub enum_values: Option<Vec<String>> }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterOperator { Eq, Neq, Contains, Gt, Lt }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreFilter { pub column: String, pub operator: FilterOperator, pub value: Value }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection { Asc, Desc }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreSort { pub column: String, pub direction: SortDirection }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreRequest { pub connection_id: String, pub namespace: String, pub object: String, pub cursor: Option<String>, pub limit: u32, pub filters: Option<Vec<ExploreFilter>>, pub sort: Option<Vec<ExploreSort>>, pub search: Option<String> }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreResult { pub columns: Vec<DataColumn>, pub rows: Vec<serde_json::Map<String, Value>>, pub next_cursor: Option<String>, #[serde(skip_serializing_if = "Option::is_none")] pub total_rows: Option<u64>, pub duration_ms: u64, pub truncated: bool }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCountRequest { pub connection_id: String, pub namespace: String, pub object: String, pub filters: Option<Vec<ExploreFilter>> }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCountResult { pub count: u64, pub estimated: bool, pub duration_ms: u64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectListResult { pub objects: Vec<DataObject>, #[serde(skip_serializing_if = "Option::is_none")] pub namespaces: Option<Vec<String>>, pub refreshed_at: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceLookupRequest { pub connection_id: String, pub database: String, pub source_collection: String, pub field: String, pub value: Value, pub search_all: bool, pub reference: Option<DataColumnReference> }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedDocument { pub database: String, pub collection: String, pub document: serde_json::Map<String, Value>, #[serde(skip_serializing_if = "Option::is_none")] pub columns: Option<Vec<DataColumn>> }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceLookupResult { pub matches: Vec<LinkedDocument>, pub inferred_collections: Vec<String>, pub searched_collections: usize, pub search_all_available: bool, pub strategy: String }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult { pub status: String, pub latency_ms: u64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cursor { pub offset: u64 }
