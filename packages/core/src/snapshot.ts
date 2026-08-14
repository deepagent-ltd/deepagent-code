export namespace Snapshot {
  export type FileDiff = {
    file?: string
    patch?: string
    additions: number
    deletions: number
    status?: "added" | "deleted" | "modified"
  }

  export type DiffManifestDescriptor = {
    completeness: "complete" | "truncated"
    truncationReasons: Array<
      | "candidate_file_limit"
      | "discovery_output_limit"
      | "discovery_failed"
      | "manifest_bytes_limit"
      | "source_file_limit"
      | "source_total_limit"
      | "patch_file_limit"
      | "patch_total_limit"
      | "materialization_failed"
      | "time_limit"
    >
    manifestHash: string
    totalFiles: number
    totalFilesExact: boolean
    statisticsExact?: boolean
    includedFiles: number
    truncatedFiles: number
  }
}
