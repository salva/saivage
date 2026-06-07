export type FsErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "NOT_A_FILE" | "IO_ERROR";

export interface ClassifiedFsError {
  code: FsErrorCode;
  error: string;
  errno?: string;
}

// Exported for unit testing only. classifyFsError is intentionally
// scoped to read's contract; other filesystem tools should add
// their own classifier if they need one.
export function classifyFsError(
  err: unknown,
  path: string,
  context: "stat" | "open" | "read" | "close",
): ClassifiedFsError {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  const msg = (err as Error | undefined)?.message ?? String(err);
  switch (errno) {
    case "ENOENT":
    case "ENOTDIR":
      return {
        code: "NOT_FOUND",
        error:
          `NOT_FOUND: ${path} does not exist (during ${context}). ` +
          `Check the spelling or use read on the parent directory.`,
        errno,
      };
    case "EACCES":
    case "EPERM":
      return {
        code: "PERMISSION_DENIED",
        error:
          `PERMISSION_DENIED: filesystem denied access to ${path} ` +
          `(during ${context}). Verify permissions on the path and its parents.`,
        errno,
      };
    case "EISDIR":
      return {
        code: "NOT_A_FILE",
        error:
          `NOT_A_FILE: ${path} is a directory (open returned EISDIR). ` +
          `Use read.`,
        errno,
      };
    default:
      return {
        code: "IO_ERROR",
        error:
          `IO_ERROR: low-level I/O error on ${path} (during ${context}): ${msg}`,
        ...(errno ? { errno } : {}),
      };
  }
}
