//! Fixed-purpose values shared by the independent framed channel and the
//! original in-process Windows factory. They do not reconstruct native authority.
use serde::{Deserialize, Serialize};
use crate::protocol::Identity;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub identity: Identity,
    pub stamp: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose { Settings, LocalOperator, McpLegacyAuth, McpSecretEnvelopes, McpSecretMigration, McpOauthJournal }

impl Purpose {
    pub fn permits(self, name: &str) -> bool {
        match self {
            Self::Settings => ["settings.json", ".settings-operation.json", ".settings-receipt.json"].contains(&name),
            Self::LocalOperator => name == "installation.json",
            Self::McpLegacyAuth => name == "mcp-auth.json",
            Self::McpSecretEnvelopes => name == "mcp-secrets.dpapi.json",
            Self::McpSecretMigration => name == "mcp-secret-migration.json",
            Self::McpOauthJournal => false,
        }
    }
    pub fn limit(self) -> usize { match self { Self::LocalOperator => 1024, _ => 1_048_576 } }
}
