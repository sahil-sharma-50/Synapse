//! Command-entry sessions owned by Synapse; never attach to an existing terminal.
use serde::{Deserialize, Serialize};

const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CommandSpec {
    pub shell: String,
    pub command: String,
    pub cwd: String,
    #[serde(default)]
    pub distro: String,
    #[serde(default)]
    pub background: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub launched: bool,
}

pub fn validate(spec: &CommandSpec) -> Result<(), String> {
    if !matches!(spec.shell.as_str(), "powershell" | "cmd" | "wsl") {
        return Err("Choose powershell, cmd, or wsl.".into());
    }
    if spec.command.trim().is_empty() || spec.command.len() > 32 * 1024 || spec.command.contains('\0') {
        return Err("Command must contain 1–32768 bytes without NUL characters.".into());
    }
    if spec.cwd.is_empty() || spec.cwd.len() > 4096 || spec.cwd.contains(['\0', '\n', '\r']) {
        return Err("A valid working directory is required.".into());
    }
    if spec.shell == "wsl" {
        if !spec.cwd.starts_with('/') {
            return Err("WSL working directories must be absolute Linux paths, such as /home/user/project.".into());
        }
        if spec.distro.len() > 128
            || !spec
                .distro
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err("Invalid WSL distribution name.".into());
        }
    } else {
        if !spec.distro.is_empty() {
            return Err("A distribution is only valid for WSL.".into());
        }
        let path = std::path::Path::new(&spec.cwd);
        if !path.is_absolute() || !path.is_dir() {
            return Err("Windows working directory must be an existing absolute directory.".into());
        }
    }
    Ok(())
}

/// Only these literal Docker operations can use previously granted repeat consent.
/// No quoted arguments, shell operators, substitutions, flags, or remote contexts.
pub fn repeat_safe(spec: &CommandSpec) -> bool {
    if !spec
        .command
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b" -_.".contains(&c))
    {
        return false;
    }
    let args: Vec<_> = spec.command.split_ascii_whitespace().collect();
    let name = |s: &str| !s.starts_with('-') && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c));
    match args.as_slice() {
        ["docker", "start" | "inspect", containers @ ..] => {
            !containers.is_empty() && containers.iter().all(|c| name(c))
        }
        ["docker", "compose", "up", "-d"] => true,
        _ => false,
    }
}

// This masks familiar token prefixes, not arbitrary secrets. Captures remain local.
fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for part in text.split_inclusive(char::is_whitespace) {
        if let Some(start) = ["sk-", "ghp_", "github_pat_"].iter().filter_map(|p| part.find(p)).min() {
            out.push_str(&part[..start]);
            out.push_str("[redacted]");
            out.extend(
                part.chars()
                    .rev()
                    .take_while(|c| c.is_whitespace())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev(),
            );
        } else {
            out.push_str(part);
        }
    }
    out
}

pub fn execute(
    spec: &CommandSpec,
    timeout_secs: u64,
    cancelled: &dyn Fn() -> bool,
    on_output: &mut dyn FnMut(&str),
) -> Result<CommandResult, String> {
    validate(spec)?;
    if cancelled() {
        return Err("Command cancelled before launch.".into());
    }
    #[cfg(windows)]
    return platform::execute(spec, timeout_secs, cancelled, on_output);
    #[cfg(not(windows))]
    {
        let _ = (timeout_secs, on_output);
        Err("Managed command sessions currently require Windows.".into())
    }
}

pub fn shutdown() {
    #[cfg(windows)]
    platform::shutdown();
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::io::{Read, Write};
    use std::os::windows::{io::AsRawHandle, process::CommandExt};
    use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Pipes::PeekNamedPipe;

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    struct Job(HANDLE);
    // The handle is owned here and accessed only under the registry mutex after transfer.
    unsafe impl Send for Job {}
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    struct Session {
        _job: Job,
        child: Child,
        stdout: ChildStdout,
        stderr: ChildStderr,
        out: Vec<u8>,
        err: Vec<u8>,
        out_truncated: bool,
        err_truncated: bool,
        guest: Option<(String, u32)>,
    }

    impl Drop for Session {
        fn drop(&mut self) {
            if let Some((distro, pid)) = self.guest.take() {
                // Only our setsid process group; never terminate the distribution or unrelated Linux tasks.
                let mut command = Command::new("wsl.exe");
                if !distro.is_empty() {
                    command.args(["--distribution", &distro]);
                }
                command.args(["--exec", "/bin/kill", "-KILL", "--", &format!("-{pid}")]);
                match spawn(command) {
                    Ok(mut cleanup) => {
                        drop(cleanup.child.stdin.take());
                        if let Err(error) =
                            wait(&mut cleanup, Instant::now() + Duration::from_secs(3), &|| false, false)
                        {
                            eprintln!("Owned WSL group cleanup failed: {error}");
                        }
                    }
                    Err(error) => eprintln!("Owned WSL group cleanup failed: {error}"),
                }
            }
        }
    }

    static BACKGROUND: OnceLock<Mutex<Vec<Session>>> = OnceLock::new();
    static MONITOR: OnceLock<()> = OnceLock::new();

    fn spawn(mut command: Command) -> Result<Session, String> {
        // Suspend before assignment so even an immediately spawned grandchild belongs to our job.
        command
            .creation_flags(0x08000000 | 0x00000004)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let job = Job(unsafe { CreateJobObjectW(None, None).map_err(|e| format!("Create process job: {e}"))? });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(|e| format!("Configure process job: {e}"))?;
        }
        let mut child = command.spawn().map_err(|e| format!("Launch command: {e}"))?;
        let handle = HANDLE(child.as_raw_handle());
        if let Err(e) = unsafe { AssignProcessToJobObject(job.0, handle) } {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Own command process tree: {e}"));
        }
        if unsafe { NtResumeProcess(handle) } < 0 {
            drop(job);
            let _ = child.wait();
            return Err("Resume command process failed.".into());
        }
        Ok(Session {
            stdout: child.stdout.take().ok_or("Missing stdout pipe")?,
            stderr: child.stderr.take().ok_or("Missing stderr pipe")?,
            _job: job,
            child,
            out: Vec::new(),
            err: Vec::new(),
            out_truncated: false,
            err_truncated: false,
            guest: None,
        })
    }

    fn drain<R: Read + AsRawHandle>(pipe: &mut R, capture: &mut Vec<u8>, truncated: &mut bool) -> Result<(), String> {
        // Polling pipes avoids blocking reader threads surviving a detached descendant.
        for _ in 0..16 {
            let mut available = 0;
            if unsafe { PeekNamedPipe(HANDLE(pipe.as_raw_handle()), None, 0, None, Some(&mut available), None) }
                .is_err()
            {
                break; // Closed pipe after process exit.
            }
            if available == 0 {
                break;
            }
            let mut buffer = [0; 4096];
            let requested = (available as usize).min(buffer.len());
            let count = pipe
                .read(&mut buffer[..requested])
                .map_err(|e| format!("Read command output: {e}"))?;
            if count == 0 {
                break;
            }
            let keep = count.min(OUTPUT_LIMIT.saturating_sub(capture.len()));
            capture.extend_from_slice(&buffer[..keep]);
            *truncated |= count > keep;
        }
        Ok(())
    }

    impl Session {
        fn drain(&mut self) -> Result<(), String> {
            drain(&mut self.stdout, &mut self.out, &mut self.out_truncated)?;
            drain(&mut self.stderr, &mut self.err, &mut self.err_truncated)
        }
        fn result(&self, exit_code: Option<i32>, launched: bool) -> CommandResult {
            let capture = |bytes: &[u8], truncated| {
                let mut text = redact(&String::from_utf8_lossy(bytes));
                if truncated {
                    text.push_str("\n[output truncated at 64 KiB]\n");
                }
                text
            };
            CommandResult {
                stdout: capture(&self.out, self.out_truncated),
                stderr: capture(&self.err, self.err_truncated),
                exit_code,
                launched,
            }
        }
    }

    fn command(spec: &CommandSpec) -> Command {
        match spec.shell.as_str() {
            "powershell" => {
                let mut command = Command::new("powershell.exe");
                command
                    .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &spec.command])
                    .current_dir(&spec.cwd);
                command
            }
            "cmd" => {
                let mut command = Command::new("cmd.exe");
                // /s removes exactly this wrapper quote pair; raw_arg preserves the approved literal.
                command
                    .args(["/d", "/s", "/c"])
                    .raw_arg(format!("\"{}\"", spec.command))
                    .current_dir(&spec.cwd);
                command
            }
            _ => {
                let mut command = Command::new("wsl.exe");
                if !spec.distro.is_empty() {
                    command.args(["--distribution", &spec.distro]);
                }
                // Constant supervisor script, approved command supplied separately as $1.
                // The handshake prevents any user code starting before its guest group is owned.
                command.args(["--cd", &spec.cwd, "--exec", "setsid", "--wait", "sh", "-c",
                    "printf 'SYNAPSE_PID:%s\\n' \"$$\"; IFS= read -r permit; [ \"$permit\" = RUN ] || exit 125; exec sh -lc \"$1\"",
                    "synapse", &spec.command]);
                command
            }
        }
    }

    fn prepare_guest(
        session: &mut Session,
        distro: &str,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        loop {
            session.drain()?;
            if let Some(end) = session.out.iter().position(|b| *b == b'\n') {
                let line = std::str::from_utf8(&session.out[..end]).map_err(|_| "Invalid WSL ownership handshake")?;
                let pid = line
                    .strip_prefix("SYNAPSE_PID:")
                    .and_then(|s| s.trim().parse::<u32>().ok())
                    .filter(|pid| *pid > 1 && *pid <= i32::MAX as u32)
                    .ok_or("Invalid WSL ownership handshake")?;
                session.guest = Some((distro.into(), pid));
                session.out.drain(..=end);
                if cancelled() {
                    return Err("Command cancelled before guest launch.".into());
                }
                let mut input = session.child.stdin.take().ok_or("Missing WSL ownership pipe")?;
                input
                    .write_all(b"RUN\n")
                    .map_err(|e| format!("Start owned WSL command: {e}"))?;
                return Ok(());
            }
            if cancelled() {
                return Err("Command cancelled before guest launch.".into());
            }
            if session
                .child
                .try_wait()
                .map_err(|e| format!("Wait for WSL: {e}"))?
                .is_some()
            {
                return Err(format!(
                    "WSL ownership requires setsid --wait: {}",
                    redact(&String::from_utf8_lossy(&session.err))
                ));
            }
            if Instant::now() >= deadline {
                return Err("WSL ownership handshake timed out.".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait(
        session: &mut Session,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
        background: bool,
    ) -> Result<Option<std::process::ExitStatus>, String> {
        loop {
            if cancelled() {
                return Err("Command cancelled; owned process tree stopped.".into());
            }
            session.drain()?;
            if let Some(status) = session.child.try_wait().map_err(|e| format!("Wait for command: {e}"))? {
                // The child can exit with up to one pipe capacity still queued.
                session.drain()?;
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                if background {
                    return Ok(None);
                }
                return Err("Command timed out; owned process tree stopped.".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub(super) fn execute(
        spec: &CommandSpec,
        timeout_secs: u64,
        cancelled: &dyn Fn() -> bool,
        on_output: &mut dyn FnMut(&str),
    ) -> Result<CommandResult, String> {
        let timeout = Duration::from_secs(timeout_secs.clamp(1, 3600));
        if spec.shell == "wsl" && !spec.distro.is_empty() {
            let mut listing = Command::new("wsl.exe");
            listing.args(["--list", "--quiet"]);
            let mut session = spawn(listing)?;
            drop(session.child.stdin.take());
            let status = wait(
                &mut session,
                Instant::now() + timeout.min(Duration::from_secs(10)),
                cancelled,
                false,
            )?;
            let raw = &session.out;
            let names = if raw.contains(&0) {
                String::from_utf16_lossy(
                    &raw.chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect::<Vec<_>>(),
                )
            } else {
                String::from_utf8_lossy(raw).into_owned()
            };
            if !status.is_some_and(|s| s.success())
                || !names
                    .lines()
                    .any(|name| name.trim().trim_start_matches('\u{feff}') == spec.distro)
            {
                return Err("The selected WSL distribution is not installed.".into());
            }
        }
        if cancelled() {
            return Err("Command cancelled before launch.".into());
        }
        let mut session = spawn(command(spec))?;
        if spec.shell == "wsl" {
            prepare_guest(
                &mut session,
                &spec.distro,
                Instant::now() + timeout.min(Duration::from_secs(10)),
                cancelled,
            )?;
        } else {
            drop(session.child.stdin.take());
        }
        let status = wait(
            &mut session,
            Instant::now()
                + if spec.background {
                    timeout.min(Duration::from_millis(500))
                } else {
                    timeout
                },
            cancelled,
            spec.background,
        )?;
        if cancelled() {
            return Err("Command cancelled; owned process tree stopped.".into());
        }
        let result = session.result(status.and_then(|s| s.code()), status.is_none());
        // Emit whole bounded captures so recognizable tokens cannot evade masking at chunk boundaries.
        if !result.stdout.is_empty() {
            on_output(&result.stdout);
        }
        if !result.stderr.is_empty() {
            on_output(&result.stderr);
        }
        if cancelled() {
            return Err("Command cancelled; owned process tree stopped.".into());
        }
        if status.is_none() {
            let registry = BACKGROUND.get_or_init(|| Mutex::new(Vec::new()));
            let mut sessions = registry.lock().map_err(|_| "Background command registry unavailable")?;
            if sessions.len() >= 16 {
                return Err("At most 16 background command sessions may run at once.".into());
            }
            eprintln!("Managed background command {} started", session.child.id());
            sessions.push(session);
            MONITOR.get_or_init(|| {
                std::thread::spawn(|| loop {
                    std::thread::sleep(Duration::from_millis(100));
                    let Some(registry) = BACKGROUND.get() else { continue };
                    let Ok(mut sessions) = registry.lock() else { break };
                    sessions.retain_mut(|session| {
                        let drained = session.drain();
                        match session.child.try_wait() {
                            Ok(None) if drained.is_ok() => true,
                            status => {
                                eprintln!("Managed background command {} ended: {status:?}", session.child.id());
                                false
                            }
                        }
                    });
                });
            });
        }
        Ok(result)
    }

    pub(super) fn shutdown() {
        if let Some(registry) = BACKGROUND.get() {
            if let Ok(mut sessions) = registry.lock() {
                sessions.clear();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(command: &str) -> CommandSpec {
        CommandSpec {
            shell: "powershell".into(),
            command: command.into(),
            cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(),
            distro: String::new(),
            background: false,
        }
    }

    #[test]
    fn literal_validation_and_repeat_consent() {
        assert!(validate(&spec("Write-Output 'ok'")).is_ok());
        assert!(!repeat_safe(&spec("docker start service; Remove-Item x")));
        assert!(!repeat_safe(&spec("docker start -a service")));
        assert!(!repeat_safe(&spec("docker --context remote start service")));
        assert!(repeat_safe(&spec("docker start service-1")));
        assert!(repeat_safe(&spec("docker compose up -d")));
        let mut invalid = spec("test");
        invalid.cwd = "relative".into();
        assert!(validate(&invalid).is_err());
        invalid.shell = "wsl".into();
        invalid.cwd = "/home/a path".into();
        invalid.distro = "Ubuntu;evil".into();
        assert!(validate(&invalid).is_err());
        invalid.distro = "Ubuntu-24.04".into();
        assert!(validate(&invalid).is_ok());
        assert_eq!(
            redact("Bearer sk-secret\nnext ghp_secret"),
            "Bearer [redacted]\nnext [redacted]"
        );
    }

    #[cfg(windows)]
    #[test]
    fn captures_both_pipes_and_exit_and_bounds_output() {
        let result = execute(
            &spec("[Console]::Out.Write('ok'); [Console]::Error.Write('err'); exit 7"),
            10,
            &|| false,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.stdout, "ok");
        assert_eq!(result.stderr, "err");
        assert_eq!(result.exit_code, Some(7));
        let result = execute(
            &spec("[Console]::Out.Write(('x' * 100000)); [Console]::Error.Write(('y' * 100000))"),
            10,
            &|| false,
            &mut |_| {},
        )
        .unwrap();
        assert!(result.stdout.len() < OUTPUT_LIMIT + 100);
        assert!(result.stderr.len() < OUTPUT_LIMIT + 100);
        assert!(result.stdout.contains("truncated"));
        assert!(result.stderr.contains("truncated"));
    }

    #[cfg(windows)]
    #[test]
    fn timeout_and_cancellation_stop_owned_commands() {
        assert!(execute(&spec("Start-Sleep -Seconds 10"), 1, &|| false, &mut |_| {})
            .unwrap_err()
            .contains("timed out"));
        let start = std::time::Instant::now();
        assert!(execute(
            &spec("Start-Sleep -Seconds 10"),
            10,
            &|| start.elapsed().as_millis() > 200,
            &mut |_| {}
        )
        .unwrap_err()
        .contains("cancelled"));
        assert!(start.elapsed().as_secs() < 3);
    }

    #[cfg(windows)]
    #[test]
    fn cmd_preserves_quoted_literal() {
        let mut spec = spec("echo \"a b\" & exit /b 3");
        spec.shell = "cmd".into();
        let result = execute(&spec, 10, &|| false, &mut |_| {}).unwrap();
        assert!(result.stdout.contains("\"a b\""));
        assert_eq!(result.exit_code, Some(3));
    }

    #[cfg(windows)]
    #[test]
    fn windows_cwd_with_spaces_is_passed_as_a_directory() {
        let dir = std::env::temp_dir().join(format!("synapse cwd test {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut spec = spec("cd");
        spec.shell = "cmd".into();
        spec.cwd = dir.to_string_lossy().into_owned();
        let result = execute(&spec, 10, &|| false, &mut |_| {});
        std::fs::remove_dir(&dir).unwrap();
        let result = result.unwrap();
        assert_eq!(result.stdout.trim(), spec.cwd);
        assert_eq!(result.exit_code, Some(0));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires an installed WSL distribution with setsid --wait"]
    fn wsl_owns_guest_group_before_running_literal_command() {
        let mut spec = spec("printf 'hello\\n'; printf 'err\\n' >&2; exit 4");
        spec.shell = "wsl".into();
        spec.cwd = "/tmp".into();
        let result = execute(&spec, 20, &|| false, &mut |_| {}).unwrap();
        assert_eq!(result.stdout, "hello\n");
        assert_eq!(result.stderr, "err\n");
        assert_eq!(result.exit_code, Some(4));
        let marker = format!(
            "/tmp/synapse-terminal-check-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        spec.command = format!("sleep 3; printf leaked > {marker}");
        assert!(execute(&spec, 1, &|| false, &mut |_| {})
            .unwrap_err()
            .contains("timed out"));
        std::thread::sleep(std::time::Duration::from_secs(3));
        spec.command = format!("test ! -e {marker}");
        assert_eq!(execute(&spec, 10, &|| false, &mut |_| {}).unwrap().exit_code, Some(0));
    }
}
