#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
// An intentionally direct syscall probe: product code cannot replace this process.
// It isolates the OS namespace boundary from the helper's earlier path checks.
int main(int argc,char **argv) {
  setbuf(stdout,NULL);
  int parent=open(argv[1],O_RDONLY|O_DIRECTORY);
  int stage=open(argv[2],O_RDONLY|O_DIRECTORY);
  if(parent<0||stage<0)return 2;
  int payload=openat(stage,"payload",O_WRONLY|O_CREAT|O_EXCL,0600);
  if(payload<0||write(payload,"replacement",11)!=11||fsync(payload)||close(payload))return 3;
  errno=0;int secret=open(argv[3],O_RDONLY);printf("secret:%d:%d\n",secret,errno);if(secret>=0)close(secret);
  errno=0;int asset=open(argv[4],O_WRONLY);printf("asset:%d:%d\n",asset,errno);if(asset>=0)close(asset);
  int sock=socket(AF_INET,SOCK_STREAM,0);
  struct sockaddr_in address={0};address.sin_family=AF_INET;address.sin_port=htons(atoi(argv[5]));inet_pton(AF_INET,"127.0.0.1",&address.sin_addr);
  errno=0;int connected=connect(sock,(struct sockaddr*)&address,sizeof(address));printf("network:%d:%d\n",connected,errno);close(sock);
  errno=0;int forbidden=fcntl(parent,80,0);printf("fcntl80:%d:%d\n",forbidden,errno);
  errno=0;forbidden=fcntl(parent,110,0);printf("fcntl110:%d:%d\n",forbidden,errno);
  printf("ready\n");if(getchar()==EOF)return 4;
  errno=0;int published=renameatx_np(stage,"payload",parent,"target",RENAME_SWAP);
  printf("publish:%d:%d\n",published,errno);
  close(parent);close(stage);return 0;
}
