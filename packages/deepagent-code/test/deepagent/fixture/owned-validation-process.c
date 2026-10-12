#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>

extern char **environ;

static void publish(const char *file) {
  FILE *out = fopen(file, "w");
  if (!out) exit(91);
  fprintf(out, "%d", getpid());
  fclose(out);
}

static void hold(const char *file) {
  signal(SIGTERM, SIG_IGN);
  publish(file);
  char heartbeat[4096];
  snprintf(heartbeat, sizeof(heartbeat), "%s.heartbeat", file);
  int fd = open(heartbeat, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) exit(92);
  while (1) { write(fd, ".", 1); usleep(20000); }
}

int main(int argc, char **argv) {
  if (argc < 2) return 93;
  if (!strcmp(argv[1], "fork-check")) {
    errno = 0;
    pid_t child = fork();
    int fork_error = errno;
    if (child == 0) _exit(0);
    if (child > 0) waitpid(child, NULL, 0);
    char *args[] = { "/usr/bin/true", NULL };
    pid_t spawned = -1;
    int spawn_error = posix_spawn(&spawned, args[0], NULL, NULL, args, environ);
    if (!spawn_error) waitpid(spawned, NULL, 0);
    printf("fork=%d errno=%d spawn=%d\n", child, fork_error, spawn_error);
    return child == -1 && fork_error == EPERM && spawn_error == EPERM ? 0 : 94;
  }
  if (!strcmp(argv[1], "hold") && argc == 3) hold(argv[2]);
  if (!strcmp(argv[1], "escape") && argc == 3) {
    signal(SIGTERM, SIG_IGN);
    pid_t child = fork();
    if (child < 0) return 95;
    if (child == 0) { if (setsid() < 0) _exit(96); hold(argv[2]); }
    while (1) pause();
  }
  if (!strcmp(argv[1], "escape-exit") && argc == 3) {
    pid_t child = fork();
    if (child < 0) return 95;
    if (child == 0) {
      if (setsid() < 0) _exit(96);
      int sink = open("/dev/null", O_WRONLY);
      dup2(sink, STDOUT_FILENO); dup2(sink, STDERR_FILENO); close(sink);
      hold(argv[2]);
    }
    return 0;
  }
  if (!strcmp(argv[1], "environment")) {
    const char *keys[] = { "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "IM_API_KEY", "DEEPAGENT_CODE_SERVER_PASSWORD",
      "HTTPS_PROXY", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BUN_OPTIONS", "MCP_OAUTH_SECRET", NULL };
    for (int n = 0; keys[n]; n++) printf("%s=%d\n", keys[n], getenv(keys[n]) != NULL);
    printf("HOME=%s\nTMPDIR=%s\n", getenv("HOME"), getenv("TMPDIR"));
    return 0;
  }
  if (!strcmp(argv[1], "output")) {
    char out[8192], err[8192];
    memset(out, 'x', sizeof(out)); memset(err, 'y', sizeof(err));
    for (int n = 0; n < 130; n++) { fwrite(out, 1, sizeof(out), stdout); fwrite(err, 1, sizeof(err), stderr); }
    return 0;
  }
  if (!strcmp(argv[1], "binary")) {
    unsigned char bytes[8192]; memset(bytes, 0xff, sizeof(bytes));
    for (int n = 0; n < 128; n++) fwrite(bytes, 1, sizeof(bytes), stdout);
    return 0;
  }
  if (!strcmp(argv[1], "network") && argc == 3) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(atoi(argv[2]));
    int result = connect(fd, (struct sockaddr *)&address, sizeof(address));
    int error = errno; close(fd);
    printf("connect=%d errno=%d\n", result, error);
    return result == -1 && error == EPERM ? 0 : 98;
  }
  if (!strcmp(argv[1], "marker") && argc == 3) { publish(argv[2]); return 0; }
  if (!strcmp(argv[1], "failed")) return 7;
  return 97;
}
