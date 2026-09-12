#include <sys/socket.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
extern int bind(int,const struct sockaddr *,socklen_t);
static int isolated_bind(int fd,const struct sockaddr *address,socklen_t size){
 if(address && address->sa_family==AF_INET && size>=sizeof(struct sockaddr_in)){
  struct sockaddr_in replacement;memcpy(&replacement,address,sizeof replacement);
  if(ntohs(replacement.sin_port)==10007){replacement.sin_port=htons(42007);return bind(fd,(struct sockaddr *)&replacement,size);}
 }
 return bind(fd,address,size);
}
__attribute__((used)) static struct {const void *replacement;const void *original;} hook __attribute__((section("__DATA,__interpose")))={(void *)isolated_bind,(void *)bind};

extern int connect(int,const struct sockaddr *,socklen_t);
static int isolated_connect(int fd,const struct sockaddr *address,socklen_t size){
 if(address && address->sa_family==AF_INET && size>=sizeof(struct sockaddr_in)){
  struct sockaddr_in replacement;memcpy(&replacement,address,sizeof replacement);
  if(ntohs(replacement.sin_port)==10007 && ntohl(replacement.sin_addr.s_addr)==0x7f000001){replacement.sin_port=htons(42007);return connect(fd,(struct sockaddr *)&replacement,size);}
 }
 return connect(fd,address,size);
}
__attribute__((used)) static struct {const void *replacement;const void *original;} hook_connect __attribute__((section("__DATA,__interpose")))={(void *)isolated_connect,(void *)connect};
__attribute__((constructor)) static void loaded(void){fprintf(stderr,"Reference IPC isolation loaded: 10007 -> 42007\n");}
