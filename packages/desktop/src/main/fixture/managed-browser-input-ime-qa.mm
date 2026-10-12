#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <cstring>
#include <fstream>
#include <string>

static Class clientClass;
static Method methods[4];
static IMP baseline[4];
static IMP foreignOriginal;
static bool foreignInstalled=false;
static std::string cleanupPath;
static unsigned delegated=0;
static __strong NSView *lateTarget;
static NSWindow *windowFor(napi_env env,napi_value value){
  bool buffer=false;void *bytes=nullptr;size_t size=0;void *pointer=nullptr;
  if(napi_is_buffer(env,value,&buffer)!=napi_ok||!buffer||napi_get_buffer_info(env,value,&bytes,&size)!=napi_ok||size!=sizeof(pointer))return nil;
  std::memcpy(&pointer,bytes,size);if(!pointer)return nil;
  for(NSWindow *window in NSApp.windows)if(window.contentView&&(__bridge void*)window.contentView==pointer)return window;
  return nil;
}
static NSView *findClient(NSView *root,unsigned depth,unsigned&count){
  if(!root||depth>32||++count>1024)return nil;
  if(object_getClass(root)==clientClass)return root;
  for(NSView *child in root.subviews)if(NSView *found=findClient(child,depth+1,count))return found;
  return nil;
}
static napi_value invoke(napi_env env,napi_callback_info info){
  napi_value args[2];size_t count=2;unsigned kind=0;napi_get_cb_info(env,info,&count,args,nullptr,nullptr);
  NSWindow *window=count==2?windowFor(env,args[0]):nil;unsigned nodes=0;
  NSView *view=window?findClient(window.contentView,0,nodes):nil;
  if(!NSThread.isMainThread||!view||napi_get_value_uint32(env,args[1],&kind)!=napi_ok||kind>7){napi_throw_error(env,nullptr,"QA_IME_TARGET");return nullptr;}
  id<NSTextInputClient> client=(id<NSTextInputClient>)view;
  if(kind==0)[client insertText:@"候选" replacementRange:NSMakeRange(NSNotFound,0)];
  if(kind==1)[client setMarkedText:@"标记" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(NSNotFound,0)];
  if(kind==2)[client unmarkText];
  if(kind==3){NSView *parent=view.superview;[view removeFromSuperview];[parent addSubview:view];}
  if(kind==4){NSView *root=window.contentView;window.contentView=[[NSView alloc]initWithFrame:root.frame];window.contentView=root;}
  if(kind>=5){
    const NSEventType types[]={NSEventTypeMouseEntered,NSEventTypeMouseExited,NSEventTypeCursorUpdate};
    NSEvent *event=[NSEvent enterExitEventWithType:types[kind-5] location:NSMakePoint(20,20) modifierFlags:0
      timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:1 trackingNumber:0 userData:nullptr];
    if(!event||event.window!=window){napi_throw_error(env,nullptr,"QA_EVENT");return nullptr;}
    [NSApp postEvent:event atStart:NO];
  }
  napi_value result;napi_get_undefined(env,&result);return result;
}
static void foreignInsert(id self,SEL selector,id text,NSRange range){
  delegated++;((void(*)(id,SEL,id,NSRange))foreignOriginal)(self,selector,text,range);
}
static napi_value foreign(napi_env env,napi_callback_info info){
  napi_value argument;size_t count=1;bool enabled=false;napi_get_cb_info(env,info,&count,&argument,nullptr,nullptr);
  if(count!=1||napi_get_value_bool(env,argument,&enabled)!=napi_ok)return nullptr;
  if(enabled&&!foreignInstalled){foreignOriginal=method_setImplementation(methods[0],(IMP)foreignInsert);foreignInstalled=true;}
  if(!enabled&&foreignInstalled){method_setImplementation(methods[0],baseline[0]);foreignInstalled=false;}
  napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value subclass(napi_env env,napi_callback_info info){
  napi_value argument;size_t count=1;napi_get_cb_info(env,info,&count,&argument,nullptr,nullptr);
  NSWindow *window=count==1?windowFor(env,argument):nil;unsigned nodes=0;
  NSView *view=window?findClient(window.contentView,0,nodes):nil;
  if(!view){napi_throw_error(env,nullptr,"QA_CLIENT");return nullptr;}
  Class changed=objc_getClass("DACQARetiredTextClient");
  if(!changed){changed=objc_allocateClassPair(clientClass,"DACQARetiredTextClient",0);objc_registerClassPair(changed);}
  object_setClass(view,changed);
  // The class remains changed until the separate restore call; no arbitrary address crosses JS.
  napi_value result;napi_get_undefined(env,&result);return result;
}
static NSView *findChanged(NSView *root){if(object_getClass(root)==objc_getClass("DACQARetiredTextClient"))return root;
  for(NSView *child in root.subviews)if(NSView *found=findChanged(child))return found;return nil;}
static napi_value restoreClass(napi_env env,napi_callback_info info){
  napi_value argument;size_t count=1;napi_get_cb_info(env,info,&count,&argument,nullptr,nullptr);
  NSWindow *window=count==1?windowFor(env,argument):nil;NSView *view=window?findChanged(window.contentView):nil;
  if(view)object_setClass(view,clientClass);napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value state(napi_env env,napi_callback_info){
  napi_value result,restored,foreign,called;napi_create_object(env,&result);bool original=true;
  for(unsigned i=0;i<4;i++)if(method_getImplementation(methods[i])!=baseline[i])original=false;
  napi_get_boolean(env,original,&restored);napi_get_boolean(env,method_getImplementation(methods[0])==(IMP)foreignInsert,&foreign);
  napi_create_uint32(env,delegated,&called);napi_set_named_property(env,result,"restored",restored);
  napi_set_named_property(env,result,"foreignOwned",foreign);napi_set_named_property(env,result,"delegated",called);return result;
}
static napi_value cleanup(napi_env env,napi_callback_info info){
  napi_value argument;size_t count=1,length=0;napi_get_cb_info(env,info,&count,&argument,nullptr,nullptr);char text[4096];
  if(count!=1||napi_get_value_string_utf8(env,argument,text,sizeof(text),&length)!=napi_ok||!length||length>=sizeof(text))return nullptr;
  cleanupPath.assign(text,length);napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value abi(napi_env env,napi_callback_info){
  napi_value result;napi_create_array(env,&result);
  for(unsigned i=0;i<4;i++){napi_value value;napi_create_string_utf8(env,method_getTypeEncoding(methods[i]),NAPI_AUTO_LENGTH,&value);napi_set_element(env,result,i,value);}
  return result;
}
static napi_value late(napi_env env,napi_callback_info info){
  napi_value argument;size_t count=1;napi_get_cb_info(env,info,&count,&argument,nullptr,nullptr);
  NSWindow *window=count==1?windowFor(env,argument):nil;unsigned nodes=0;
  lateTarget=window?findClient(window.contentView,0,nodes):nil;
  if(!lateTarget){napi_throw_error(env,nullptr,"QA_LATE_TARGET");return nullptr;}
  napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value initialize(napi_env env,napi_value exports){
  clientClass=objc_getClass("RenderWidgetHostViewCocoa");
  SEL selectors[]={@selector(insertText:replacementRange:),@selector(setMarkedText:selectedRange:replacementRange:),@selector(unmarkText),@selector(viewDidMoveToWindow)};
  for(unsigned i=0;i<4;i++){methods[i]=class_getInstanceMethod(clientClass,selectors[i]);if(!methods[i]){napi_throw_error(env,nullptr,"QA_ABI");return nullptr;}baseline[i]=method_getImplementation(methods[i]);}
  napi_property_descriptor props[]={
    {"invoke",nullptr,invoke,nullptr,nullptr,nullptr,napi_default,nullptr},{"foreign",nullptr,foreign,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"subclass",nullptr,subclass,nullptr,nullptr,nullptr,napi_default,nullptr},{"restoreClass",nullptr,restoreClass,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"state",nullptr,state,nullptr,nullptr,nullptr,napi_default,nullptr},{"cleanup",nullptr,cleanup,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"abi",nullptr,abi,nullptr,nullptr,nullptr,napi_default,nullptr},{"late",nullptr,late,nullptr,nullptr,nullptr,napi_default,nullptr}};
  napi_define_properties(env,exports,8,props);
  napi_add_env_cleanup_hook(env,[](void*){if(cleanupPath.empty())return;bool lateCall=false;
    if(lateTarget&&foreignInstalled){unsigned before=delegated;[(id<NSTextInputClient>)lateTarget insertText:@"" replacementRange:NSMakeRange(NSNotFound,0)];lateCall=delegated==before+1;method_setImplementation(methods[0],baseline[0]);foreignInstalled=false;lateTarget=nil;}
    bool original=true;for(unsigned i=0;i<4;i++)if(method_getImplementation(methods[i])!=baseline[i])original=false;
    std::ofstream file(cleanupPath);file<<"{\"restored\":"<<(original?"true":"false");if(lateCall)file<<",\"lateDelegated\":true";file<<"}";},nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)
