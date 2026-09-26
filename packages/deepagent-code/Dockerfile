FROM alpine AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add libgcc libstdc++ ripgrep

COPY dist/deepagent-code-linux-x64-baseline-musl/bin/deepagent-code /usr/local/bin/deepagent-code

RUN deepagent-code --version
ENTRYPOINT ["deepagent-code"]
