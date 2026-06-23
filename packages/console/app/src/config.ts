/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://deepagent-code.ai",

  // GitHub
  github: {
    repoUrl: "https://github.com/lessweb/deepagent-code",
    starsFormatted: {
      compact: "160K",
      full: "160,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/deepagent-code",
    discord: "https://discord.gg/deepagent-code",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "900",
    commits: "13,000",
    monthlyUsers: "7.5M",
  },
} as const
