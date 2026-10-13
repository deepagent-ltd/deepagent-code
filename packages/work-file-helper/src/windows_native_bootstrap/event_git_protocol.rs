//! Fixed raw-plumbing syntax and byte limits only. A Plan is not a repository,
//! index, target-path, executable or mutation authority; the Native producer
//! must consume its original held facts before launching any of these argv.
use std::io;

pub(super) struct Plan {
    pub argv: Vec<String>,
    pub mutating: bool,
    pub stdout_bytes: usize,
}

/// The caller supplies its already-captured friendly paths. This checks their
/// fixed syntax and an exact target argument; the caller still owns all held
/// repository/target identity, namespace, purpose and mutation checks.
pub(super) fn validate(
    args: &[String],
    stdin_bytes: usize,
    blob: bool,
    commit_time: Option<u64>,
    directory: &str,
    target_path: Option<&str>,
) -> io::Result<Plan> {
    let value = plan(args, blob, stdin_bytes, commit_time)?;
    if !friendly_directory(directory) || target_path.is_some_and(|target| !friendly_directory(target)) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    if value.argv[0] == "worktree" && value.argv[1] == "add" {
        let supplied = if args.len() == 4 { &args[2] } else { &args[4] };
        if target_path != Some(supplied.as_str()) || supplied == directory {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    Ok(value)
}

fn friendly_directory(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() <= 2048 && bytes.get(..3).is_some_and(|prefix| prefix[0].is_ascii_alphabetic()
        && prefix[1] == b':' && matches!(prefix[2], b'/' | b'\\'))
        && !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        && (value.len() == 3 || value[3..].split(['/', '\\']).all(|part| !matches!(part, "" | "." | "..")))
}

pub(super) fn plan(
    args: &[String],
    blob: bool,
    stdin_bytes: usize,
    commit_time: Option<u64>,
) -> io::Result<Plan> {
    if args.is_empty() || args.len() > 64 || stdin_bytes > 16_777_216
        || args.iter().any(|arg| arg.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'))
        || args.iter().try_fold(0usize, |bytes, arg| bytes.checked_add(arg.len()))
            .is_none_or(|bytes| bytes > 8192)
        || blob && args[0] != "cat-file"
        || commit_time.is_some_and(|time| time == 0 || time > 9_007_199_254_740_991)
        || !valid(args)
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let creating = args[0] == "worktree" && args[1] == "add";
    let mut argv = args.to_vec();
    if creating { argv.insert(2, "--no-checkout".to_owned()); }
    Ok(Plan {
        argv,
        mutating: creating || matches!(args[0].as_str(), "read-tree" | "hash-object" | "update-index"
            | "write-tree" | "commit-tree" | "update-ref"),
        stdout_bytes: if blob { 16_777_216 } else if args[0] == "rev-list" { 2_097_152 } else { 1_048_576 },
    })
}

// Keep this grammar aligned with EventWorkGit.valid. No variant selects a
// filter, textconv, hook, pager, submodule, network or repository merge driver.
fn valid(args: &[String]) -> bool {
    match args[0].as_str() {
        "cat-file" => args.len() == 3 && matches!(args[1].as_str(), "blob" | "-s" | "-t") && oid(&args[2]),
        "ls-tree" => args.len() == 4 && args[1] == "-rz" && args[2] == "--full-tree" && oid(&args[3]),
        "hash-object" => args.len() == 3 && args[1] == "-w" && args[2] == "--stdin",
        "read-tree" => args.len() == 2 && (oid(&args[1]) || args[1] == "--empty"),
        "update-index" => args.len() == 3 && args[1] == "-z" && args[2] == "--index-info",
        "write-tree" => args.len() == 1,
        "commit-tree" => args.len() == 6 && oid(&args[1]) && args[2] == "-p" && oid(&args[3])
            && args[4] == "-m" && args[5] == "DeepAgent Code event node artifact",
        "update-ref" => args.len() == 4 && reference(&args[1]) && oid(&args[2]) && oid(&args[3]),
        "merge-base" => args.len() == 4 && args[1] == "--is-ancestor" && oid(&args[2]) && oid(&args[3]),
        "show-ref" => args.len() == 4 && args[1] == "--verify" && args[2] == "--quiet" && reference(&args[3]),
        "rev-parse" => args.len() == 2 && (matches!(args[1].as_str(), "--show-toplevel" | "--show-object-format" | "HEAD")
                || reference(&args[1]))
            || args.len() == 3 && args[1] == "--path-format=absolute"
                && matches!(args[2].as_str(), "--git-common-dir" | "--git-dir")
            || args.len() == 3 && args[1] == "--verify" && (args[2] == "HEAD^{commit}"
                || oid(args[2].strip_suffix("^{commit}").unwrap_or(&args[2]))),
        "diff-tree" => args.len() == 5 && args[1] == "--no-commit-id" && args[2] == "--name-only"
            && args[3] == "-rz" && oid(&args[4]),
        "rev-list" => args.len() == 4 && args[1] == "--objects" && args[2] == "--no-object-names"
            && args[3].split_once("..").is_some_and(|(from, to)| oid(from) && oid(to)),
        "worktree" => args.len() == 3 && args[1] == "list" && args[2] == "--porcelain"
            || args.len() == 4 && args[1] == "add" && absolute(&args[2]) && branch(&args[3])
            || args.len() == 6 && args[1] == "add" && args[2] == "-b" && branch(&args[3])
                && absolute(&args[4]) && oid(&args[5]),
        _ => false,
    }
}

fn oid(value: &str) -> bool {
    (40..=64).contains(&value.len()) && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn branch(value: &str) -> bool {
    value.strip_prefix("deepagent-code/event-").is_some_and(|suffix|
        suffix.len() == 24 && suffix.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}

fn reference(value: &str) -> bool {
    value.strip_prefix("refs/heads/").is_some_and(branch)
}

// This module is Windows-only. Match the lexical win32.isAbsolute grammar,
// including root-relative paths; only the original Native target can authorize
// a canonical member, so this predicate never upgrades a string to placement.
fn absolute(value: &str) -> bool {
    value.starts_with(['/', '\\']) || value.as_bytes().get(..3).is_some_and(|bytes|
        bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
}

#[cfg(test)]
mod tests {
    use super::{plan, validate};

    fn args(values: &[&str]) -> Vec<String> { values.iter().map(|value| (*value).to_owned()).collect() }

    #[test]
    fn consumes_fixed_raw_plumbing_and_inserts_no_checkout() {
        let oid = "a".repeat(40);
        let reference = format!("refs/heads/deepagent-code/event-{}", "b".repeat(24));
        let branch = format!("deepagent-code/event-{}", "b".repeat(24));
        for values in [
            args(&["rev-parse", "HEAD"]), args(&["rev-parse", "--show-toplevel"]),
            args(&["rev-parse", "--show-object-format"]), args(&["rev-parse", &reference]),
            args(&["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            args(&["rev-parse", "--path-format=absolute", "--git-dir"]),
            args(&["rev-parse", "--verify", "HEAD^{commit}"]),
            args(&["rev-parse", "--verify", &format!("{oid}^{{commit}}")]),
            args(&["show-ref", "--verify", "--quiet", &reference]),
            args(&["worktree", "list", "--porcelain"]),
            args(&["merge-base", "--is-ancestor", &oid, &oid]),
            args(&["ls-tree", "-rz", "--full-tree", &oid]), args(&["cat-file", "blob", &oid]),
            args(&["cat-file", "-s", &oid]), args(&["cat-file", "-t", &oid]),
            args(&["read-tree", &oid]), args(&["read-tree", "--empty"]),
            args(&["hash-object", "-w", "--stdin"]), args(&["update-index", "-z", "--index-info"]),
            args(&["write-tree"]), args(&["commit-tree", &oid, "-p", &oid, "-m", "DeepAgent Code event node artifact"]),
            args(&["update-ref", &reference, &oid, &oid]),
            args(&["diff-tree", "--no-commit-id", "--name-only", "-rz", &oid]),
            args(&["rev-list", "--objects", "--no-object-names", &format!("{oid}..{oid}")]),
        ] { assert_eq!(plan(&values, false, 0, None).unwrap().argv, values); }
        for values in [args(&["worktree", "add", "C:\\owned\\node", &branch]),
            args(&["worktree", "add", "-b", &branch, "C:\\owned\\node", &oid])] {
            let result = plan(&values, false, 0, None).unwrap();
            assert!(result.mutating); assert_eq!(result.argv[2], "--no-checkout");
            assert_eq!(result.argv.len(), values.len() + 1);
        }
    }

    #[test]
    fn classifies_mutation_and_bounds_real_output() {
        let oid = "a".repeat(64);
        assert!(!plan(&args(&["cat-file", "blob", &oid]), true, 0, None).unwrap().mutating);
        assert_eq!(plan(&args(&["cat-file", "blob", &oid]), true, 0, None).unwrap().stdout_bytes, 16_777_216);
        assert_eq!(plan(&args(&["rev-list", "--objects", "--no-object-names", &format!("{oid}..{oid}")]), false, 0, None)
            .unwrap().stdout_bytes, 2_097_152);
        assert_eq!(plan(&args(&["write-tree"]), false, 0, None).unwrap().stdout_bytes, 1_048_576);
        assert!(plan(&args(&["read-tree", "--empty"]), false, 0, None).unwrap().mutating);
        assert!(!plan(&args(&["worktree", "list", "--porcelain"]), false, 0, None).unwrap().mutating);
    }

    #[test]
    fn rejects_expansion_injection_and_preinserted_checkout_switch() {
        let oid = "a".repeat(40);
        let branch = format!("deepagent-code/event-{}", "b".repeat(24));
        for values in [args(&["checkout", &oid]), args(&["status", "--porcelain"]),
            args(&["cat-file", "--filters", &oid]), args(&["cat-file", "--textconv", &oid]),
            args(&["commit-tree", &oid, "-p", &oid, "-m", "caller message"]),
            args(&["worktree", "add", "--no-checkout", "C:\\owned", &branch]),
            args(&["worktree", "add", "relative", &branch]),
            args(&["update-ref", "refs/heads/main", &oid, &oid]),
            args(&["rev-parse", "--verify", "--end-of-options", &oid]),
            args(&["rev-parse", "HEAD\n"]), args(&["-c", "core.hooksPath=foreign", "write-tree"])] {
            assert!(plan(&values, false, 0, None).is_err());
        }
        assert!(plan(&args(&["write-tree"]), true, 0, None).is_err());
    }

    #[test]
    fn enforces_admission_bytes_and_safe_timestamp_before_planning() {
        assert!(plan(&vec!["write-tree".to_owned(); 65], false, 0, None).is_err());
        assert!(plan(&args(&["worktree", "add", &format!("C:\\{}", "x".repeat(8192)),
            &format!("deepagent-code/event-{}", "b".repeat(24))]), false, 0, None).is_err());
        assert!(plan(&args(&["write-tree"]), false, 16_777_217, None).is_err());
        assert!(plan(&args(&["write-tree"]), false, 0, Some(0)).is_err());
        assert!(plan(&args(&["write-tree"]), false, 0, Some(9_007_199_254_740_992)).is_err());
        assert!(plan(&args(&["write-tree"]), false, 16_777_216, Some(9_007_199_254_740_991)).is_ok());
    }

    #[test]
    fn requires_original_friendly_directory_and_exact_native_target() {
        let branch = format!("deepagent-code/event-{}", "b".repeat(24));
        let values = args(&["worktree", "add", "C:\\private\\node", &branch]);
        assert!(validate(&values, 0, false, None, "C:\\project", Some("C:\\private\\node")).is_ok());
        assert!(validate(&values, 0, false, None, "C:\\project", None).is_err());
        assert!(validate(&values, 0, false, None, "C:\\project", Some("C:\\foreign\\node")).is_err());
        assert!(validate(&values, 0, false, None, "C:\\private\\node", Some("C:\\private\\node")).is_err());
        for directory in ["relative", "\\project", "\\\\server\\share", "\\\\?\\C:\\project", "C:\\x\\..\\project", "C:\\x\\.\\project", "C:\\x\\\\project", "C:\\project\0"] {
            assert!(validate(&args(&["write-tree"]), 0, false, None, directory, None).is_err());
        }
    }
}
