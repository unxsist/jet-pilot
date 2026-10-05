//! Small file helpers: atomic replacement and advisory locks.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 12 random lowercase base32 characters (`a-z2-7`), for ids and temp names.
pub fn random_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bytes = [0u8; 12];
    fill_random(&mut bytes);
    bytes
        .iter()
        .map(|b| ALPHABET[(*b & 31) as usize] as char)
        .collect()
}

/// Fills `buf` from the OS random number generator.
pub fn fill_random(buf: &mut [u8]) {
    // getrandom only fails when the OS has no entropy source at all.
    getrandom::getrandom(buf).expect("the operating system's random number generator failed");
}

/// A sibling temp path of `path`: `<name>.tmp-<random>`.
pub fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    path.with_file_name(format!("{name}.tmp-{}", random_id()))
}

/// Creates a new file (never an existing one) with `mode` on unix.
pub fn create_new(path: &Path, mode: u32) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options.open(path)
}

/// Writes `bytes` to `path` atomically: a temp file next to it (with
/// `mode` on unix), fsync, rename over `path`, fsync the directory. Readers
/// see either the old or the new contents, never a partial file.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let tmp = temp_sibling(path);
    let result = (|| {
        let mut file = create_new(&tmp, mode)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        rename_replacing(&tmp, path)?;
        sync_parent(path);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// `rename(from, to)`, replacing `to`. Windows refuses while another process
/// briefly has `to` open (antivirus, kubectl reading it): retry for ~1 s.
pub fn rename_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempts = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e)
                if cfg!(windows)
                    && attempts < 20
                    && e.kind() == std::io::ErrorKind::PermissionDenied =>
            {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Flushes the directory entry of `path` (unix; best effort).
pub fn sync_parent(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// An exclusive advisory lock on a lock file, released on drop.
#[derive(Debug)]
pub struct FileLock {
    file: File,
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// Takes an exclusive lock on `path` (created 0600 if missing), waiting up
/// to `timeout` for another holder to release it.
pub fn lock_file(path: &Path, timeout: Duration) -> std::io::Result<FileLock> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(FileLock { file }),
            Err(std::fs::TryLockError::WouldBlock) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("{} is locked by another process", path.display()),
                ))
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_ids_are_base32() {
        let id = random_id();
        assert_eq!(id.len(), 12);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_lowercase() || ('2'..='7').contains(&c)));
        assert_ne!(random_id(), random_id());
    }

    #[test]
    fn atomic_write_replaces_and_sets_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        write_atomic(&path, b"one", 0o600).unwrap();
        write_atomic(&path, b"two", 0o600).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        // No temp files left behind.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn lock_is_exclusive_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.lock");
        let first = lock_file(&path, Duration::from_secs(1)).unwrap();
        let err = lock_file(&path, Duration::from_millis(100)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        drop(first);
        lock_file(&path, Duration::from_millis(100)).unwrap();
    }
}
