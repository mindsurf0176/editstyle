use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 18910;
const BUNDLED_BACKEND_DIR: &str = "backend";

struct BackendState {
    child: Mutex<Option<Child>>,
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendStartResponse {
    started: bool,
    already_running: bool,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveExportRequest {
    source_path: String,
    default_file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveExportBundleRequest {
    primary_source_path: String,
    companion_source_paths: Vec<String>,
    default_file_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveExportBundleResponse {
    saved_primary_path: String,
    saved_companion_paths: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BundledBackendManifest {
    #[serde(default)]
    runtime: BundledRuntimeManifest,
    #[serde(default)]
    tools: BundledToolsManifest,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BundledRuntimeManifest {
    #[serde(default)]
    portable: bool,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct BundledToolsManifest {
    #[serde(default)]
    ffmpeg: BundledToolManifest,
    #[serde(default)]
    ffprobe: BundledToolManifest,
}

#[derive(Debug, Deserialize, Default)]
struct BundledToolManifest {
    #[serde(default)]
    mode: String,
}

fn backend_addr() -> SocketAddr {
    format!("{BACKEND_HOST}:{BACKEND_PORT}")
        .parse()
        .expect("valid backend address")
}

fn is_backend_online() -> bool {
    TcpStream::connect_timeout(&backend_addr(), Duration::from_millis(250)).is_ok()
}

fn workspace_root() -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn backend_launch_args() -> Vec<OsString> {
    vec![
        OsString::from("--host"),
        OsString::from(BACKEND_HOST),
        OsString::from("--port"),
        OsString::from(BACKEND_PORT.to_string()),
    ]
}

fn env_flag_enabled(key: &str) -> bool {
    matches!(
        env::var(key).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

fn allow_host_backend_fallback() -> bool {
    cfg!(debug_assertions) || env_flag_enabled("CUTAI_DESKTOP_ALLOW_HOST_BACKEND")
}

fn allow_unsupported_bundled_backend() -> bool {
    env_flag_enabled("CUTAI_DESKTOP_ALLOW_UNSUPPORTED_BUNDLED_BACKEND")
}

fn bundled_backend_launcher(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(custom_path) = env::var("CUTAI_DESKTOP_BACKEND_LAUNCHER") {
        let launcher = PathBuf::from(custom_path);
        if launcher.exists() {
            return Ok(launcher);
        }
        return Err(format!(
            "CUTAI_DESKTOP_BACKEND_LAUNCHER does not exist: {}",
            launcher.display()
        ));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("Failed to resolve Tauri resource dir: {err}"))?;
    let launcher = resource_dir
        .join(BUNDLED_BACKEND_DIR)
        .join("run-backend.sh");

    if launcher.exists() {
        Ok(launcher)
    } else {
        Err(format!(
            "Bundled desktop backend launcher not found at {}",
            launcher.display()
        ))
    }
}

fn bundled_backend_manifest(app: &AppHandle) -> Result<BundledBackendManifest, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("Failed to resolve Tauri resource dir: {err}"))?;
    let manifest_path = resource_dir.join(BUNDLED_BACKEND_DIR).join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path).map_err(|err| {
        format!(
            "Failed to read bundled backend manifest at {}: {err}",
            manifest_path.display()
        )
    })?;

    serde_json::from_slice(&manifest_bytes).map_err(|err| {
        format!(
            "Failed to parse bundled backend manifest at {}: {err}",
            manifest_path.display()
        )
    })
}

fn is_command_available(command: &str) -> bool {
    if command.trim().is_empty() {
        return false;
    }

    let path = PathBuf::from(command);
    if path.components().count() > 1 {
        return path.exists();
    }

    env::var_os("PATH")
        .and_then(|paths| env::split_paths(&paths).find(|dir| dir.join(command).exists()))
        .is_some()
}

fn missing_external_backend_tools(manifest: &BundledBackendManifest) -> Vec<&'static str> {
    let mut missing = Vec::new();

    if manifest.tools.ffmpeg.mode == "external"
        && !is_command_available(
            &env::var("CUTAI_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_string()),
        )
    {
        missing.push("ffmpeg");
    }

    if manifest.tools.ffprobe.mode == "external"
        && !is_command_available(
            &env::var("CUTAI_FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".to_string()),
        )
    {
        missing.push("ffprobe");
    }

    missing
}

fn spawn_command(
    program: impl AsRef<Path>,
    args: &[OsString],
    working_dir: &Path,
) -> Result<Child, String> {
    let mut command = Command::new(program.as_ref());
    command
        .args(args)
        .current_dir(working_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command
        .spawn()
        .map_err(|err| format!("{}: {err}", program.as_ref().display()))
}

fn spawn_host_backend_command(root: &Path) -> Result<Child, String> {
    let args = backend_launch_args();
    let module_args = {
        let mut values = vec![
            OsString::from("-m"),
            OsString::from("cutai.cli"),
            OsString::from("server"),
        ];
        values.extend(args.iter().cloned());
        values
    };
    let mut last_error: Option<String> = None;

    if let Ok(python) = env::var("CUTAI_DESKTOP_PYTHON") {
        match spawn_command(Path::new(&python), &module_args, root) {
            Ok(child) => return Ok(child),
            Err(err) => last_error = Some(err),
        }
    }

    for venv_python in [
        root.join(".venv313/bin/python"),
        root.join(".venv/bin/python"),
    ] {
        if !venv_python.exists() {
            continue;
        }
        match spawn_command(&venv_python, &module_args, root) {
            Ok(child) => return Ok(child),
            Err(err) => last_error = Some(err),
        }
    }

    for python in ["python3", "python"] {
        match spawn_command(Path::new(python), &module_args, root) {
            Ok(child) => return Ok(child),
            Err(err) => last_error = Some(err),
        }
    }

    let cutai_args = {
        let mut values = vec![OsString::from("server")];
        values.extend(args);
        values
    };
    match spawn_command(Path::new("cutai"), &cutai_args, root) {
        Ok(child) => Ok(child),
        Err(err) => {
            let final_error = last_error
                .map(|previous| format!("{err}; previous attempt: {previous}"))
                .unwrap_or(err);
            Err(format!(
                "Unable to launch CutAI backend from host tools. Set CUTAI_DESKTOP_PYTHON or CUTAI_DESKTOP_BACKEND_LAUNCHER if needed. Last error: {final_error}"
            ))
        }
    }
}

fn spawn_backend_command(app: &AppHandle) -> Result<Child, String> {
    let root = workspace_root().ok_or("Failed to locate workspace root")?;

    match bundled_backend_launcher(app) {
        Ok(launcher) => {
            let manifest = bundled_backend_manifest(app)?;
            if !manifest.runtime.portable && !allow_unsupported_bundled_backend() {
                let reason = manifest
                    .runtime
                    .reason
                    .unwrap_or_else(|| "The bundled runtime was marked non-portable.".to_string());
                return Err(format!(
                    "This packaged CutAI backend bundle is marked non-portable and is blocked from startup by default. {reason} Rebuild with a portable runtime, or set CUTAI_DESKTOP_ALLOW_UNSUPPORTED_BUNDLED_BACKEND=1 for local validation only."
                ));
            }

            let missing_tools = missing_external_backend_tools(&manifest);
            if !missing_tools.is_empty() {
                return Err(format!(
                    "This packaged CutAI build depends on external {}. Install them on the machine or rebuild with CUTAI_DESKTOP_BUNDLED_FFMPEG_PATH and CUTAI_DESKTOP_BUNDLED_FFPROBE_PATH so the app carries its own media tools.",
                    missing_tools.join(" and ")
                ));
            }

            let working_dir = launcher.parent().map(Path::to_path_buf).ok_or_else(|| {
                format!(
                    "Bundled backend launcher has no parent: {}",
                    launcher.display()
                )
            })?;
            spawn_command(&launcher, &backend_launch_args(), &working_dir)
        }
        Err(packaged_error) => {
            if allow_host_backend_fallback() {
                spawn_host_backend_command(&root)
            } else {
                Err(format!(
                    "{packaged_error}. Packaged CutAI builds require the bundled backend resource. Run `pnpm backend:bundle` during the release build or explicitly opt into host fallback with CUTAI_DESKTOP_ALLOW_HOST_BACKEND=1."
                ))
            }
        }
    }
}

#[tauri::command]
fn start_backend(
    app: AppHandle,
    state: State<'_, BackendState>,
) -> Result<BackendStartResponse, String> {
    if is_backend_online() {
        return Ok(BackendStartResponse {
            started: false,
            already_running: true,
            port: BACKEND_PORT,
        });
    }

    let mut child_slot = state
        .child
        .lock()
        .map_err(|_| "Failed to lock backend state".to_string())?;

    if let Some(child) = child_slot.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                return Ok(BackendStartResponse {
                    started: false,
                    already_running: true,
                    port: BACKEND_PORT,
                });
            }
            Ok(Some(_)) | Err(_) => {
                *child_slot = None;
            }
        }
    }

    let mut child = spawn_backend_command(&app)?;

    for _ in 0..30 {
        if is_backend_online() {
            *child_slot = Some(child);
            return Ok(BackendStartResponse {
                started: true,
                already_running: false,
                port: BACKEND_PORT,
            });
        }

        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "CutAI backend exited before startup completed ({status})"
            ));
        }

        thread::sleep(Duration::from_millis(200));
    }

    let _ = child.kill();
    let _ = child.wait();
    Err(format!(
        "CutAI backend did not become ready on {BACKEND_HOST}:{BACKEND_PORT}"
    ))
}

fn stop_backend_process(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<BackendState>() {
        if let Ok(mut child_slot) = state.child.lock() {
            if let Some(child) = child_slot.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *child_slot = None;
        }
    }
}

fn existing_path_or_ancestor(path: &Path) -> Option<PathBuf> {
    for candidate in path.ancestors() {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
    }

    None
}

fn open_with_command(program: &str, args: &[&str], target: &Path) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .arg(target)
        .status()
        .map_err(|err| format!("Failed to launch {program}: {err}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with status {status}"))
    }
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let requested = PathBuf::from(path.trim());
    if path.trim().is_empty() {
        return Err("Path is required".to_string());
    }

    let existing_target = existing_path_or_ancestor(&requested).ok_or_else(|| {
        format!(
            "Path does not exist and no parent directory was found: {}",
            requested.display()
        )
    })?;

    #[cfg(target_os = "macos")]
    {
        if requested.exists() && requested.is_file() {
            return open_with_command("open", &["-R"], &requested);
        }

        return open_with_command("open", &[], &existing_target);
    }

    #[cfg(target_os = "windows")]
    {
        if requested.exists() && !requested.is_dir() {
            let status = Command::new("explorer")
                .arg(format!("/select,{}", requested.display()))
                .status()
                .map_err(|err| format!("Failed to launch explorer: {err}"))?;

            if status.success() {
                return Ok(());
            }
        }

        return open_with_command("explorer", &[], &existing_target);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        open_with_command("xdg-open", &[], &existing_target)
    }
}

fn validate_source_file(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} path is required"));
    }

    let source = PathBuf::from(trimmed);
    if !source.exists() {
        return Err(format!("{label} does not exist: {}", source.display()));
    }
    if !source.is_file() {
        return Err(format!("{label} is not a file: {}", source.display()));
    }

    Ok(source)
}

fn copy_file_if_needed(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination {
        return Ok(());
    }

    fs::copy(source, destination).map_err(|err| {
        format!(
            "Failed to export file from {} to {}: {}",
            source.display(),
            destination.display(),
            err
        )
    })?;
    Ok(())
}

fn destination_with_stem_and_suffix(
    directory: &Path,
    stem: &str,
    suffix: &str,
    extension: &str,
) -> PathBuf {
    directory.join(format!("{stem}{suffix}{extension}"))
}

fn path_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default()
}

fn build_companion_destination(
    primary_destination: &Path,
    companion_source: &Path,
    used_paths: &mut BTreeSet<PathBuf>,
    index: usize,
) -> PathBuf {
    let directory = primary_destination
        .parent()
        .unwrap_or_else(|| Path::new("."));
    let stem = primary_destination
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("cutai-export");
    let extension = path_extension(companion_source);

    let mut candidate = destination_with_stem_and_suffix(directory, stem, "", &extension);
    if candidate != primary_destination && !used_paths.contains(&candidate) && !candidate.exists() {
        used_paths.insert(candidate.clone());
        return candidate;
    }

    let original_stem = companion_source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("artifact");
    let fallback_suffix = format!("-{}-{}", original_stem.replace(' ', "-"), index + 1);
    candidate = destination_with_stem_and_suffix(directory, stem, &fallback_suffix, &extension);

    let mut dedupe = 2usize;
    while used_paths.contains(&candidate) || candidate == primary_destination || candidate.exists()
    {
        let suffix = format!("{fallback_suffix}-{dedupe}");
        candidate = destination_with_stem_and_suffix(directory, stem, &suffix, &extension);
        dedupe += 1;
    }

    used_paths.insert(candidate.clone());
    candidate
}

#[tauri::command]
fn save_exported_file(request: SaveExportRequest) -> Result<Option<String>, String> {
    let source = validate_source_file(&request.source_path, "Source file")?;
    let default_file_name = request.default_file_name.trim();
    if default_file_name.is_empty() {
        return Err("Default file name is required".to_string());
    }

    let destination = rfd::FileDialog::new()
        .set_file_name(default_file_name)
        .save_file();

    let Some(destination) = destination else {
        return Ok(None);
    };

    copy_file_if_needed(&source, &destination)?;
    Ok(Some(destination.display().to_string()))
}

#[tauri::command]
fn save_export_bundle(
    request: SaveExportBundleRequest,
) -> Result<Option<SaveExportBundleResponse>, String> {
    let primary_source = validate_source_file(&request.primary_source_path, "Primary export file")?;
    let companion_sources = request
        .companion_source_paths
        .iter()
        .map(|path| validate_source_file(path, "Companion export file"))
        .collect::<Result<Vec<_>, _>>()?;

    let default_file_name = request.default_file_name.trim();
    if default_file_name.is_empty() {
        return Err("Default file name is required".to_string());
    }

    let destination = rfd::FileDialog::new()
        .set_file_name(default_file_name)
        .save_file();

    let Some(destination) = destination else {
        return Ok(None);
    };

    copy_file_if_needed(&primary_source, &destination)?;

    let mut used_paths = BTreeSet::from([destination.clone()]);
    let mut saved_companion_paths = Vec::with_capacity(companion_sources.len());

    for (index, companion_source) in companion_sources.iter().enumerate() {
        let companion_destination =
            build_companion_destination(&destination, companion_source, &mut used_paths, index);
        copy_file_if_needed(companion_source, &companion_destination)?;
        saved_companion_paths.push(companion_destination.display().to_string());
    }

    Ok(Some(SaveExportBundleResponse {
        saved_primary_path: destination.display().to_string(),
        saved_companion_paths,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_backend,
            reveal_path,
            save_exported_file,
            save_export_bundle
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_backend_process(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        allow_host_backend_fallback, build_companion_destination, destination_with_stem_and_suffix,
        missing_external_backend_tools, BundledBackendManifest, BundledRuntimeManifest,
        BundledToolManifest, BundledToolsManifest,
    };
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn native_media_policy_allows_local_preview_and_render_playback() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("Tauri config");
        let policy = config["app"]["security"]["csp"].as_str().expect("CSP");
        let media = policy
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("media-src "))
            .expect("explicit media policy");

        assert!(media
            .split_whitespace()
            .any(|source| source == "http://127.0.0.1:18910"));
        assert!(!media.split_whitespace().any(|source| source == "*"));
    }

    #[test]
    fn companion_destination_uses_selected_video_basename() {
        let primary = PathBuf::from("/tmp/My Clip-render.mp4");
        let companion = Path::new("/tmp/render.ass");
        let mut used = BTreeSet::from([primary.clone()]);

        let derived = build_companion_destination(&primary, companion, &mut used, 0);

        assert_eq!(derived, PathBuf::from("/tmp/My Clip-render.ass"));
    }

    #[test]
    fn companion_destination_disambiguates_duplicate_extensions() {
        let primary = PathBuf::from("/tmp/export.mp4");
        let companion = Path::new("/tmp/export.mp4");
        let mut used = BTreeSet::from([primary.clone()]);

        let derived = build_companion_destination(&primary, companion, &mut used, 0);

        assert_eq!(derived, PathBuf::from("/tmp/export-export-1.mp4"));
    }

    #[test]
    fn companion_destination_skips_existing_file_on_disk() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("cutai-desktop-test-{unique}"));
        fs::create_dir_all(&dir).expect("test dir");

        let primary_destination = dir.join("clip-render.mp4");
        let existing_sidecar = dir.join("clip-render.ass");
        fs::write(&existing_sidecar, "existing").expect("existing sidecar");

        let companion_destination = build_companion_destination(
            &primary_destination,
            Path::new("/tmp/render.ass"),
            &mut BTreeSet::from([primary_destination.clone()]),
            0,
        );

        assert_eq!(companion_destination, dir.join("clip-render-render-1.ass"));

        fs::remove_file(existing_sidecar).ok();
        fs::remove_dir(dir).ok();
    }

    #[test]
    fn missing_external_backend_tools_reports_each_unbundled_binary() {
        let manifest = BundledBackendManifest {
            runtime: BundledRuntimeManifest {
                portable: false,
                reason: None,
            },
            tools: BundledToolsManifest {
                ffmpeg: BundledToolManifest {
                    mode: "external".to_string(),
                },
                ffprobe: BundledToolManifest {
                    mode: "external".to_string(),
                },
            },
        };

        let previous_path = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        std::env::remove_var("CUTAI_FFMPEG_PATH");
        std::env::remove_var("CUTAI_FFPROBE_PATH");

        let missing = missing_external_backend_tools(&manifest);

        match previous_path {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }

        assert_eq!(missing, vec!["ffmpeg", "ffprobe"]);
    }

    #[test]
    fn release_host_fallback_stays_opt_in() {
        if cfg!(debug_assertions) {
            return;
        }

        assert!(!allow_host_backend_fallback());
    }

    #[test]
    fn destination_builder_preserves_directory_and_extension() {
        let destination =
            destination_with_stem_and_suffix(Path::new("/tmp"), "clip", "-sidecar", ".ass");
        assert_eq!(destination, PathBuf::from("/tmp/clip-sidecar.ass"));
    }
}
