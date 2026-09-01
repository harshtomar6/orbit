use crate::{models::*, state::{LocalState, PoolHandle}};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use futures_util::{stream, StreamExt, TryStreamExt};
use mongodb::bson::{doc, Bson, Document};
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::{Column, MySql, MySqlPool, PgPool, Postgres, QueryBuilder, Row};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::time::timeout;
use uuid::Uuid;

const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const COUNT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 2_000_000;

fn quote(value: &str, marker: char) -> String { format!("{marker}{}{marker}", value.replace(marker, &format!("{marker}{marker}"))) }
fn decode_cursor(cursor: Option<&str>) -> Result<u64, String> { match cursor { None => Ok(0), Some(value) => { let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| "Invalid pagination cursor.".to_string())?; let parsed: Cursor = serde_json::from_slice(&bytes).map_err(|_| "Invalid pagination cursor.".to_string())?; Ok(parsed.offset) } } }
fn encode_cursor(offset: u64) -> Result<String, String> { Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor { offset }).map_err(|error| error.to_string())?)) }
fn record<'a>(records: &'a [ConnectionRecord], id: &str) -> Result<&'a ConnectionRecord, String> { records.iter().find(|item| item.public.id == id).ok_or_else(|| "Local connection not found.".to_string()) }
fn json_value<T: serde::Serialize>(value: Option<T>) -> Value { value.and_then(|item| serde_json::to_value(item).ok()).unwrap_or(Value::Null) }

fn pg_document(row: &sqlx::postgres::PgRow) -> Result<Map<String, Value>, String> {
    let value = row.try_get::<sqlx::types::Json<Value>, _>("orbit_document").map_err(|error| error.to_string())?.0;
    value.as_object().cloned().ok_or_else(|| "PostgreSQL returned an invalid row document.".to_string())
}
fn mysql_cell(row: &sqlx::mysql::MySqlRow, index: usize) -> Value { if let Ok(value) = row.try_get::<Option<String>, _>(index) { return json_value(value); } if let Ok(value) = row.try_get::<Option<i64>, _>(index) { return json_value(value); } if let Ok(value) = row.try_get::<Option<u64>, _>(index) { return json_value(value); } if let Ok(value) = row.try_get::<Option<f64>, _>(index) { return json_value(value); } if let Ok(value) = row.try_get::<Option<bool>, _>(index) { return json_value(value); } Value::Null }

fn push_pg_value(builder: &mut QueryBuilder<Postgres>, value: &Value, contains: bool) { if contains { builder.push_bind(format!("%{}%", value.as_str().unwrap_or(&value.to_string()))); } else if let Some(value) = value.as_str() { builder.push_bind(value.to_owned()); } else if let Some(value) = value.as_i64() { builder.push_bind(value); } else if let Some(value) = value.as_f64() { builder.push_bind(value); } else if let Some(value) = value.as_bool() { builder.push_bind(value); } else { builder.push_bind(value.clone()); } }
fn push_mysql_value(builder: &mut QueryBuilder<MySql>, value: &Value, contains: bool) { if contains { builder.push_bind(format!("%{}%", value.as_str().unwrap_or(&value.to_string()))); } else if let Some(value) = value.as_str() { builder.push_bind(value.to_owned()); } else if let Some(value) = value.as_i64() { builder.push_bind(value); } else if let Some(value) = value.as_f64() { builder.push_bind(value); } else if let Some(value) = value.as_bool() { builder.push_bind(value); } else { builder.push_bind(value.to_string()); } }

async fn pg_columns(pool: &PgPool, namespace: &str, object: &str) -> Result<Vec<DataColumn>, String> { let rows = timeout(QUERY_TIMEOUT, sqlx::query("SELECT a.attname name, pg_catalog.format_type(a.atttypid,a.atttypmod) native_type, NOT a.attnotnull nullable, EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey)) primary_key, fk.reference_namespace, fk.reference_object, fk.reference_column, (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=a.atttypid) enum_values FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN LATERAL (SELECT rn.nspname reference_namespace,rc.relname reference_object,ra.attname reference_column FROM pg_constraint con JOIN LATERAL generate_subscripts(con.conkey,1) pos(i) ON true JOIN pg_class rc ON rc.oid=con.confrelid JOIN pg_namespace rn ON rn.oid=rc.relnamespace JOIN pg_attribute ra ON ra.attrelid=con.confrelid AND ra.attnum=con.confkey[pos.i] WHERE con.conrelid=a.attrelid AND con.contype='f' AND con.conkey[pos.i]=a.attnum ORDER BY con.oid LIMIT 1) fk ON true WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum").bind(namespace).bind(object).fetch_all(pool)).await.map_err(|_| "Schema introspection timed out.".to_string())?.map_err(|error| error.to_string())?; Ok(rows.into_iter().map(|row| { let reference_namespace = row.try_get::<Option<String>, _>("reference_namespace").ok().flatten(); let reference_object = row.try_get::<Option<String>, _>("reference_object").ok().flatten(); let reference_column = row.try_get::<Option<String>, _>("reference_column").ok().flatten(); let reference = match (reference_namespace, reference_object, reference_column) { (Some(namespace), Some(object), Some(column)) => Some(DataColumnReference { namespace, object, column }), _ => None }; let enum_values = row.try_get::<Option<sqlx::types::Json<Value>>, _>("enum_values").ok().flatten().and_then(|value| value.0.as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(String::from)).collect::<Vec<_>>())).filter(|items| !items.is_empty()); DataColumn { name: row.get("name"), native_type: row.get("native_type"), nullable: row.get("nullable"), primary_key: Some(row.get("primary_key")), reference, enum_values } }).collect()) }
async fn mysql_columns(pool: &MySqlPool, namespace: &str, object: &str) -> Result<Vec<DataColumn>, String> { let rows = timeout(QUERY_TIMEOUT, sqlx::query("SELECT COLUMN_NAME name,COLUMN_TYPE native_type,IS_NULLABLE nullable,COLUMN_KEY column_key FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION").bind(namespace).bind(object).fetch_all(pool)).await.map_err(|_| "Schema introspection timed out.".to_string())?.map_err(|error| error.to_string())?; Ok(rows.into_iter().map(|row| DataColumn { name: row.get("name"), native_type: row.get("native_type"), nullable: row.get::<String, _>("nullable") == "YES", primary_key: Some(row.get::<String, _>("column_key") == "PRI"), reference: None, enum_values: None }).collect()) }

#[tauri::command]
pub async fn local_list_connections(state: State<'_, LocalState>) -> Result<Vec<DatabaseConnection>, String> { Ok(state.records.read().await.iter().map(|record| record.public.clone()).collect()) }

#[tauri::command]
pub async fn local_create_connection(input: LocalConnectionInput, state: State<'_, LocalState>) -> Result<DatabaseConnection, String> { let uses_direct_uri = matches!(&input.kind, DatabaseKind::Mongodb | DatabaseKind::Postgres) && input.connection_string.as_deref().is_some_and(|value| !value.trim().is_empty()); if input.name.trim().is_empty() || (!uses_direct_uri && (input.host.trim().is_empty() || input.database.trim().is_empty() || input.username.trim().is_empty() || input.password.is_empty())) { return Err(if uses_direct_uri { "Connection name is required.".into() } else { "All connection fields are required.".into() }); } let uri = LocalState::connection_uri(&input)?; let database_label = LocalState::database_label(&input)?; let started = Instant::now(); let pool = timeout(QUERY_TIMEOUT, LocalState::connect(&input.kind, &uri, &database_label)).await.map_err(|_| "Connection test timed out.".to_string())??; let id = format!("local_{}", Uuid::new_v4()); let secret_ref = format!("secret_{}", Uuid::new_v4()); LocalState::store_secret(&secret_ref, &uri)?; let public = DatabaseConnection { id: id.clone(), name: input.name, kind: input.kind, environment: input.environment, database: database_label, read_only: true, status: "healthy".into(), latency_ms: Some(started.elapsed().as_millis() as u64), last_schema_refresh: None, access_level: "read_only".into(), local: true }; state.records.write().await.push(ConnectionRecord { public: public.clone(), secret_ref }); state.pools.write().await.insert(id, pool); if let Err(error) = state.persist().await { state.records.write().await.retain(|record| record.public.id != public.id); return Err(error); } Ok(public) }

#[derive(Deserialize)] #[serde(rename_all = "camelCase")] pub struct LocalConnectionPatch { pub name: Option<String>, pub environment: Option<String> }
#[tauri::command]
pub async fn local_update_connection(id: String, input: LocalConnectionPatch, state: State<'_, LocalState>) -> Result<DatabaseConnection, String> { let updated = { let mut records = state.records.write().await; let item = records.iter_mut().find(|record| record.public.id == id).ok_or_else(|| "Local connection not found.".to_string())?; if let Some(name) = input.name { if name.trim().is_empty() { return Err("Connection name cannot be empty.".into()); } item.public.name = name; } if let Some(environment) = input.environment { item.public.environment = environment; } item.public.clone() }; state.persist().await?; Ok(updated) }

#[tauri::command]
pub async fn local_remove_connection(id: String, state: State<'_, LocalState>) -> Result<bool, String> { state.close_pool(&id).await; let secret = { let mut records = state.records.write().await; let index = records.iter().position(|record| record.public.id == id).ok_or_else(|| "Local connection not found.".to_string())?; records.remove(index).secret_ref }; LocalState::delete_secret(&secret)?; state.persist().await?; Ok(true) }

#[tauri::command]
pub async fn local_test_connection(id: String, state: State<'_, LocalState>) -> Result<HealthResult, String> { let item = { let records = state.records.read().await; record(&records, &id)?.clone() }; state.close_pool(&id).await; let started = Instant::now(); let pool = state.pool_for(&item).await?; match pool { PoolHandle::Postgres(pool) => { timeout(QUERY_TIMEOUT, sqlx::query("SELECT 1").execute(&pool)).await.map_err(|_| "Connection test timed out.".to_string())?.map_err(|error| error.to_string())?; }, PoolHandle::Mysql(pool) => { timeout(QUERY_TIMEOUT, sqlx::query("SELECT 1").execute(&pool)).await.map_err(|_| "Connection test timed out.".to_string())?.map_err(|error| error.to_string())?; }, PoolHandle::Mongodb(client) => { timeout(QUERY_TIMEOUT, client.database("admin").run_command(doc! { "ping": 1 })).await.map_err(|_| "Connection test timed out.".to_string())?.map_err(|error| error.to_string())?; } } let latency = started.elapsed().as_millis() as u64; { let mut records = state.records.write().await; if let Some(record) = records.iter_mut().find(|record| record.public.id == id) { record.public.status = "healthy".into(); record.public.latency_ms = Some(latency); } } state.persist().await?; Ok(HealthResult { status: "healthy".into(), latency_ms: latency }) }

fn is_mongo_system_namespace(namespace: &str) -> bool { matches!(namespace.to_ascii_lowercase().as_str(), "admin" | "config" | "local") }
fn is_mongo_system_collection(collection: &str) -> bool { collection.to_ascii_lowercase().starts_with("system.") }

async fn mongo_collection_objects(connection_id: &str, client: &mongodb::Client, database: &str) -> Result<Vec<DataObject>, String> {
    let collections = client.database(database).list_collection_names().authorized_collections(true).await.map_err(|error| format!("Could not list collections in {database}: {error}"))?.into_iter().filter(|name| !is_mongo_system_collection(name));
    let database_name = database.to_string();
    let connection_id = connection_id.to_string();
    let mut objects = stream::iter(collections).map(|name| {
        let collection = client.database(&database_name).collection::<Document>(&name);
        let database_name = database_name.clone();
        let connection_id = connection_id.clone();
        async move {
            let estimated_rows = timeout(Duration::from_secs(2), collection.estimated_document_count()).await.ok().and_then(Result::ok);
            DataObject { connection_id, namespace: database_name, name, kind: "collection".into(), estimated_rows }
        }
    }).buffer_unordered(8).collect::<Vec<_>>().await;
    objects.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(objects)
}

pub async fn list_objects_for(record: &ConnectionRecord, pool: PoolHandle) -> Result<(Vec<DataObject>, Option<Vec<String>>), String> {
    match pool {
        PoolHandle::Postgres(pool) => { let rows = timeout(QUERY_TIMEOUT, sqlx::query("SELECT n.nspname namespace,c.relname name,CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END kind,GREATEST(c.reltuples,0)::bigint estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY n.nspname,c.relname").fetch_all(&pool)).await.map_err(|_| "Schema introspection timed out.".to_string())?.map_err(|error| error.to_string())?; Ok((rows.into_iter().map(|row| DataObject { connection_id: record.public.id.clone(), namespace: row.get("namespace"), name: row.get("name"), kind: row.get("kind"), estimated_rows: row.try_get::<i64, _>("estimated_rows").ok().map(|value| value.max(0) as u64) }).collect(), None)) },
        PoolHandle::Mysql(pool) => { let rows = timeout(QUERY_TIMEOUT, sqlx::query("SELECT TABLE_SCHEMA namespace,TABLE_NAME name,CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END kind,TABLE_ROWS estimated_rows FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME").bind(&record.public.database).fetch_all(&pool)).await.map_err(|_| "Schema introspection timed out.".to_string())?.map_err(|error| error.to_string())?; Ok((rows.into_iter().map(|row| DataObject { connection_id: record.public.id.clone(), namespace: row.get("namespace"), name: row.get("name"), kind: row.get("kind"), estimated_rows: row.try_get("estimated_rows").ok() }).collect(), None)) },
        PoolHandle::Mongodb(client) => timeout(QUERY_TIMEOUT, async {
            let mut databases = client.list_database_names().authorized_databases(true).await.map_err(|error| format!("Could not list MongoDB databases: {error}"))?;
            databases.retain(|database| !is_mongo_system_namespace(database));
            databases.sort();
            let objects = if let Some(database) = databases.first() {
                mongo_collection_objects(&record.public.id, &client, database).await?
            } else { Vec::new() };
            Ok((objects, Some(databases)))
        }).await.map_err(|_| "Schema introspection timed out.".to_string())?,
    }
}

#[tauri::command]
pub async fn local_list_objects(id: String, state: State<'_, LocalState>) -> Result<ObjectListResult, String> { let item = { let records = state.records.read().await; record(&records, &id)?.clone() }; let (objects, namespaces) = list_objects_for(&item, state.pool_for(&item).await?).await?; let refreshed_at = Utc::now().to_rfc3339(); { let mut records = state.records.write().await; if let Some(record) = records.iter_mut().find(|record| record.public.id == id) { record.public.last_schema_refresh = Some(refreshed_at.clone()); } } state.persist().await?; Ok(ObjectListResult { objects, namespaces, refreshed_at }) }

#[tauri::command]
pub async fn local_list_namespace_objects(id: String, namespace: String, state: State<'_, LocalState>) -> Result<ObjectListResult, String> {
    let item = { let records = state.records.read().await; record(&records, &id)?.clone() };
    if !matches!(item.public.kind, DatabaseKind::Mongodb) { return Err("Lazy database expansion is only available for MongoDB connections.".into()); }
    let PoolHandle::Mongodb(client) = state.pool_for(&item).await? else { return Err("MongoDB connection is unavailable.".into()); };
    let objects = timeout(QUERY_TIMEOUT, mongo_collection_objects(&id, &client, &namespace)).await.map_err(|_| "Collection discovery timed out.".to_string())??;
    Ok(ObjectListResult { objects, namespaces: None, refreshed_at: Utc::now().to_rfc3339() })
}

#[tauri::command]
pub async fn local_explore(request: ExploreRequest, state: State<'_, LocalState>) -> Result<ExploreResult, String> { if request.limit == 0 || request.limit > 200 { return Err("Local Explore limit must be between 1 and 200.".into()); } let item = { let records = state.records.read().await; record(&records, &request.connection_id)?.clone() }; let pool = state.pool_for(&item).await?; let offset = decode_cursor(request.cursor.as_deref())?; let started = Instant::now(); let mut result = match pool { PoolHandle::Postgres(pool) => explore_pg(&pool, &request, offset).await?, PoolHandle::Mysql(pool) => explore_mysql(&pool, &request, offset).await?, PoolHandle::Mongodb(client) => explore_mongo(&client, &request.namespace, &request, offset).await? }; result.duration_ms = started.elapsed().as_millis() as u64; if serde_json::to_vec(&result.rows).map_err(|error| error.to_string())?.len() > MAX_RESPONSE_BYTES { return Err("Local query response exceeded 2 MB.".into()); } Ok(result) }

fn mongo_filter(filters: Option<&[ExploreFilter]>) -> Result<Document, String> {
    let mut result = Document::new();
    for item in filters.unwrap_or(&[]) {
        let value = Bson::try_from(item.value.clone()).map_err(|error| format!("Invalid MongoDB filter value for {}: {error}", item.column))?;
        let expression = match item.operator {
            FilterOperator::Eq => doc! { "$eq": value },
            FilterOperator::Neq => doc! { "$ne": value },
            FilterOperator::Gt => doc! { "$gt": value },
            FilterOperator::Lt => doc! { "$lt": value },
            FilterOperator::Contains => doc! { "$regex": item.value.as_str().unwrap_or(""), "$options": "i" },
        };
        result.insert(&item.column, expression);
    }
    Ok(result)
}

#[tauri::command]
pub async fn local_count_documents(request: DocumentCountRequest, state: State<'_, LocalState>) -> Result<DocumentCountResult, String> {
    let item = { let records = state.records.read().await; record(&records, &request.connection_id)?.clone() };
    if !matches!(item.public.kind, DatabaseKind::Mongodb) { return Err("Document counts are only available for MongoDB connections.".into()); }
    let PoolHandle::Mongodb(client) = state.pool_for(&item).await? else { return Err("MongoDB connection is unavailable.".into()); };
    let started = Instant::now();
    let collection = client.database(&request.namespace).collection::<Document>(&request.object);
    let estimated = request.filters.as_ref().is_none_or(Vec::is_empty);
    let count = if estimated {
        timeout(COUNT_TIMEOUT, collection.estimated_document_count()).await.map_err(|_| "MongoDB document count timed out.".to_string())?.map_err(|error| error.to_string())?
    } else {
        let filter = mongo_filter(request.filters.as_deref())?;
        timeout(COUNT_TIMEOUT, collection.count_documents(filter)).await.map_err(|_| "MongoDB document count timed out.".to_string())?.map_err(|error| error.to_string())?
    };
    Ok(DocumentCountResult { count, estimated, duration_ms: started.elapsed().as_millis() as u64 })
}

fn reference_parts(value: &Value) -> Result<(Bson, Option<String>), String> {
    let document = value.as_object();
    let explicit_collection = document.and_then(|item| item.get("$ref")).and_then(Value::as_str).map(str::to_string);
    let id_value = document.and_then(|item| item.get("$id")).unwrap_or(value);
    let id = Bson::try_from(id_value.clone()).map_err(|error| format!("Invalid MongoDB reference: {error}"))?;
    if !matches!(id, Bson::ObjectId(_)) { return Err("Only MongoDB ObjectId references can be resolved.".into()); }
    Ok((id, explicit_collection))
}

fn inferred_collection_names(field: &str, collections: &[String]) -> Vec<String> {
    let field = field.rsplit('.').next().unwrap_or(field);
    let stem = field.strip_suffix("_id").or_else(|| field.strip_suffix("Id")).or_else(|| field.strip_suffix("ID"));
    let Some(stem) = stem.filter(|value| !value.is_empty()) else { return Vec::new(); };
    let stem = stem.to_lowercase();
    let mut guesses = vec![stem.clone(), format!("{stem}s"), format!("{stem}es")];
    if let Some(prefix) = stem.strip_suffix('y') { guesses.push(format!("{prefix}ies")); }
    collections.iter().filter(|collection| guesses.iter().any(|guess| collection.eq_ignore_ascii_case(guess))).cloned().collect()
}

fn pg_reference_text(value: &Value) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Number(value) => Ok(value.to_string()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Null => Err("A null foreign key has no referenced row.".into()),
        _ => Err("Only scalar PostgreSQL foreign keys can be resolved.".into()),
    }
}

async fn resolve_pg_foreign_key(pool: &PgPool, request: &ReferenceLookupRequest, reference: &DataColumnReference) -> Result<ReferenceLookupResult, String> {
    let columns = pg_columns(pool, &reference.namespace, &reference.object).await?;
    let native_type = columns.iter().find(|column| column.name == reference.column).map(|column| column.native_type.as_str()).ok_or_else(|| "The referenced PostgreSQL column no longer exists. Refresh the schema and try again.".to_string())?;
    let mut builder = QueryBuilder::<Postgres>::new(format!("SELECT to_jsonb(orbit_row) AS orbit_document FROM (SELECT * FROM {}.{} WHERE ", quote(&reference.namespace, '"'), quote(&reference.object, '"')));
    builder.push(quote(&reference.column, '"')).push(" = ").push_bind(pg_reference_text(&request.value)?).push("::").push(native_type).push(" LIMIT 2) orbit_row");
    let rows = timeout(QUERY_TIMEOUT, builder.build().fetch_all(pool)).await.map_err(|_| "Referenced row lookup timed out.".to_string())?.map_err(|error| error.to_string())?;
    let matches = rows.into_iter().map(|row| pg_document(&row).map(|document| LinkedDocument { database: reference.namespace.clone(), collection: reference.object.clone(), document, columns: Some(columns.clone()) })).collect::<Result<Vec<_>, _>>()?;
    if serde_json::to_vec(&matches).map_err(|error| error.to_string())?.len() > MAX_RESPONSE_BYTES { return Err("Referenced rows exceeded the 2 MB response limit.".into()); }
    Ok(ReferenceLookupResult { matches, inferred_collections: vec![format!("{}.{}", reference.namespace, reference.object)], searched_collections: 1, search_all_available: false, strategy: "foreign_key".into() })
}

#[tauri::command]
pub async fn local_resolve_reference(request: ReferenceLookupRequest, state: State<'_, LocalState>) -> Result<ReferenceLookupResult, String> {
    let item = { let records = state.records.read().await; record(&records, &request.connection_id)?.clone() };
    if matches!(&item.public.kind, DatabaseKind::Postgres) {
        let reference = request.reference.as_ref().ok_or_else(|| "PostgreSQL foreign-key metadata is missing. Refresh the schema and try again.".to_string())?;
        let PoolHandle::Postgres(pool) = state.pool_for(&item).await? else { return Err("PostgreSQL connection is unavailable.".into()); };
        return resolve_pg_foreign_key(&pool, &request, reference).await;
    }
    if !matches!(item.public.kind, DatabaseKind::Mongodb) { return Err("Linked document lookup is only available for MongoDB connections.".into()); }
    if request.field == "_id" { return Ok(ReferenceLookupResult { matches: Vec::new(), inferred_collections: Vec::new(), searched_collections: 0, search_all_available: false, strategy: "none".into() }); }
    let PoolHandle::Mongodb(client) = state.pool_for(&item).await? else { return Err("MongoDB connection is unavailable.".into()); };
    let (id, explicit_collection) = reference_parts(&request.value)?;
    let database = client.database(&request.database);
    let collections = timeout(QUERY_TIMEOUT, database.list_collection_names().authorized_collections(true)).await.map_err(|_| "Linked collection discovery timed out.".to_string())?.map_err(|error| error.to_string())?;
    let (strategy, inferred_collections, candidates) = if let Some(collection) = explicit_collection {
        ("dbref", vec![collection.clone()], vec![collection])
    } else if request.search_all {
        let values = collections.iter().filter(|collection| *collection != &request.source_collection).take(200).cloned().collect::<Vec<_>>();
        ("scan", Vec::new(), values)
    } else {
        let values = inferred_collection_names(&request.field, &collections);
        (if values.is_empty() { "none" } else { "field" }, values.clone(), values)
    };
    let searched_collections = candidates.len();
    let database_name = request.database.clone();
    let matches = timeout(QUERY_TIMEOUT, stream::iter(candidates).map(|collection_name| {
        let collection = client.database(&database_name).collection::<Document>(&collection_name);
        let id = id.clone();
        let database_name = database_name.clone();
        async move {
            let document = collection.find_one(doc! { "_id": id }).await.map_err(|error| error.to_string())?;
            Ok::<_, String>(document.map(|document| LinkedDocument {
                database: database_name,
                collection: collection_name,
                document: serde_json::to_value(document).ok().and_then(|value| value.as_object().cloned()).unwrap_or_default(),
                columns: None,
            }))
        }
    }).buffer_unordered(8).try_collect::<Vec<_>>()).await.map_err(|_| "Linked document lookup timed out.".to_string())??.into_iter().flatten().take(25).collect::<Vec<_>>();
    if serde_json::to_vec(&matches).map_err(|error| error.to_string())?.len() > MAX_RESPONSE_BYTES { return Err("Linked documents exceeded the 2 MB response limit.".into()); }
    Ok(ReferenceLookupResult { matches, inferred_collections, searched_collections, search_all_available: !request.search_all && strategy != "dbref", strategy: strategy.into() })
}

async fn explore_pg(pool: &PgPool, request: &ExploreRequest, offset: u64) -> Result<ExploreResult, String> {
    let mut builder = QueryBuilder::<Postgres>::new(format!("SELECT to_jsonb(orbit_row) AS orbit_document FROM (SELECT * FROM {}.{}", quote(&request.namespace, '"'), quote(&request.object, '"')));
    for (index, filter) in request.filters.as_deref().unwrap_or(&[]).iter().enumerate() {
        builder.push(if index == 0 { " WHERE " } else { " AND " });
        builder.push(quote(&filter.column, '"'));
        builder.push(match filter.operator { FilterOperator::Eq => " = ", FilterOperator::Neq => " <> ", FilterOperator::Gt => " > ", FilterOperator::Lt => " < ", FilterOperator::Contains => "::text ILIKE " });
        push_pg_value(&mut builder, &filter.value, matches!(filter.operator, FilterOperator::Contains));
    }
    if let Some(sort) = &request.sort {
        if !sort.is_empty() {
            builder.push(" ORDER BY ");
            for (index, item) in sort.iter().enumerate() {
                if index > 0 { builder.push(","); }
                builder.push(quote(&item.column, '"')).push(match item.direction { SortDirection::Asc => " ASC", SortDirection::Desc => " DESC" });
            }
        }
    }
    builder.push(" LIMIT ").push_bind((request.limit + 1) as i64).push(" OFFSET ").push_bind(offset as i64).push(") orbit_row");
    let fetched = timeout(QUERY_TIMEOUT, builder.build().fetch_all(pool)).await.map_err(|_| "Local query timed out.".to_string())?.map_err(|error| error.to_string())?;
    let has_more = fetched.len() > request.limit as usize;
    let rows = fetched.into_iter().take(request.limit as usize).map(|row| pg_document(&row)).collect::<Result<Vec<_>, _>>()?;
    Ok(ExploreResult { columns: pg_columns(pool, &request.namespace, &request.object).await?, next_cursor: if has_more { Some(encode_cursor(offset + rows.len() as u64)?) } else { None }, total_rows: None, rows, duration_ms: 0, truncated: has_more })
}
async fn explore_mysql(pool: &MySqlPool, request: &ExploreRequest, offset: u64) -> Result<ExploreResult, String> { let mut builder = QueryBuilder::<MySql>::new(format!("SELECT * FROM {}.{}", quote(&request.namespace, '`'), quote(&request.object, '`'))); for (index, filter) in request.filters.as_deref().unwrap_or(&[]).iter().enumerate() { builder.push(if index == 0 { " WHERE " } else { " AND " }); builder.push(quote(&filter.column, '`')); builder.push(match filter.operator { FilterOperator::Eq => " = ", FilterOperator::Neq => " <> ", FilterOperator::Gt => " > ", FilterOperator::Lt => " < ", FilterOperator::Contains => " LIKE " }); push_mysql_value(&mut builder, &filter.value, matches!(filter.operator, FilterOperator::Contains)); } if let Some(sort) = &request.sort { if !sort.is_empty() { builder.push(" ORDER BY "); for (index, item) in sort.iter().enumerate() { if index > 0 { builder.push(","); } builder.push(quote(&item.column, '`')).push(match item.direction { SortDirection::Asc => " ASC", SortDirection::Desc => " DESC" }); } } } builder.push(" LIMIT ").push_bind((request.limit + 1) as i64).push(" OFFSET ").push_bind(offset as i64); let fetched = timeout(QUERY_TIMEOUT, builder.build().fetch_all(pool)).await.map_err(|_| "Local query timed out.".to_string())?.map_err(|error| error.to_string())?; let has_more = fetched.len() > request.limit as usize; let rows = fetched.into_iter().take(request.limit as usize).map(|row| { let mut output = Map::new(); for (index, column) in row.columns().iter().enumerate() { output.insert(column.name().to_string(), mysql_cell(&row, index)); } output }).collect::<Vec<_>>(); Ok(ExploreResult { columns: mysql_columns(pool, &request.namespace, &request.object).await?, next_cursor: if has_more { Some(encode_cursor(offset + rows.len() as u64)?) } else { None }, total_rows: None, rows, duration_ms: 0, truncated: has_more }) }
async fn explore_mongo(client: &mongodb::Client, database: &str, request: &ExploreRequest, offset: u64) -> Result<ExploreResult, String> {
    let filter = mongo_filter(request.filters.as_deref())?;
    let mut sort = Document::new();
    for item in request.sort.as_deref().unwrap_or(&[]) {
        sort.insert(&item.column, match item.direction { SortDirection::Asc => 1, SortDirection::Desc => -1 });
    }
    let collection = client.database(database).collection::<Document>(&request.object);
    let cursor = timeout(QUERY_TIMEOUT, collection.find(filter).sort(sort).skip(offset).limit((request.limit + 1) as i64)).await.map_err(|_| "Local query timed out.".to_string())?.map_err(|error| error.to_string())?;
    let documents = timeout(QUERY_TIMEOUT, cursor.try_collect::<Vec<_>>()).await.map_err(|_| "Local query timed out.".to_string())?.map_err(|error| error.to_string())?;
    let has_more = documents.len() > request.limit as usize;
    let selected = documents.into_iter().take(request.limit as usize).collect::<Vec<_>>();
    let columns = selected.first().map(|document| document.iter().map(|(name, value)| DataColumn {
        name: name.clone(),
        native_type: match value { Bson::ObjectId(_) => "objectId", Bson::String(_) => "string", Bson::Int32(_) => "int32", Bson::Int64(_) => "int64", Bson::Double(_) => "double", Bson::Decimal128(_) => "decimal128", Bson::Boolean(_) => "boolean", Bson::Array(_) => "array", Bson::Document(_) => "document", Bson::DateTime(_) => "date", Bson::Binary(_) => "binary", Bson::Timestamp(_) => "timestamp", Bson::RegularExpression(_) => "regex", Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript", Bson::Symbol(_) => "symbol", Bson::Null => "null", _ => "bson" }.into(),
        nullable: true,
        primary_key: if name == "_id" { Some(true) } else { None },
        reference: None,
        enum_values: None,
    }).collect()).unwrap_or_default();
    let rows = selected.into_iter().map(|document| serde_json::to_value(document).ok().and_then(|value| value.as_object().cloned()).unwrap_or_default()).collect::<Vec<_>>();
    Ok(ExploreResult { columns, next_cursor: if has_more { Some(encode_cursor(offset + rows.len() as u64)?) } else { None }, total_rows: None, rows, duration_ms: 0, truncated: has_more })
}

#[cfg(test)]
mod tests { use super::*; #[test] fn identifies_mongo_system_objects() { assert!(is_mongo_system_namespace("admin")); assert!(is_mongo_system_namespace("CONFIG")); assert!(!is_mongo_system_namespace("app")); assert!(is_mongo_system_collection("system.keys")); assert!(!is_mongo_system_collection("users")); } #[test] fn cursor_round_trip() { let cursor = encode_cursor(42).unwrap(); assert_eq!(decode_cursor(Some(&cursor)).unwrap(), 42); } #[test] fn quotes_identifiers() { assert_eq!(quote("weird\"name", '"'), "\"weird\"\"name\""); assert_eq!(quote("weird`name", '`'), "`weird``name`"); } #[test] fn converts_scalar_postgres_foreign_keys_to_text() { assert_eq!(pg_reference_text(&serde_json::json!(42)).unwrap(), "42"); assert_eq!(pg_reference_text(&serde_json::json!("74ef")).unwrap(), "74ef"); assert!(pg_reference_text(&Value::Null).is_err()); } #[test] fn parses_mongo_extended_json_filter_values() { let value = Bson::try_from(serde_json::json!({ "$oid": "507f1f77bcf86cd799439011" })).unwrap(); assert!(matches!(value, Bson::ObjectId(_))); let value = Bson::try_from(serde_json::json!({ "$date": "2026-08-23T00:00:00Z" })).unwrap(); assert!(matches!(value, Bson::DateTime(_))); let filter = mongo_filter(Some(&[ExploreFilter { column: "ownerId".into(), operator: FilterOperator::Eq, value: serde_json::json!({ "$oid": "507f1f77bcf86cd799439011" }) }])).unwrap(); assert!(matches!(filter.get_document("ownerId").unwrap().get("$eq"), Some(Bson::ObjectId(_)))); } #[test] fn infers_conventional_reference_collections() { let collections = vec!["users".into(), "companies".into(), "audit_logs".into()]; assert_eq!(inferred_collection_names("userId", &collections), vec!["users"]); assert_eq!(inferred_collection_names("company_id", &collections), vec!["companies"]); assert!(inferred_collection_names("status", &collections).is_empty()); } }
