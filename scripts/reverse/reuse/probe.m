// Research-only instrumentation loaded into a separately signed reference copy.
// Never load this into an installed/user instance. No engine code is replaced.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <sys/socket.h>
#import <netinet/in.h>
static NSString *root;
static dispatch_source_t timer;
static BOOL headless;
static char progressKey;
static void (*originalProgress)(id, SEL, id);
static NSNumber *unsignedField(NSString *text) {
    if(!text.length || [text rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789"] invertedSet]].location!=NSNotFound)return nil;
    unsigned long long value=0;NSScanner *scanner=[NSScanner scannerWithString:text];
    if(![scanner scanUnsignedLongLong:&value] || !scanner.isAtEnd || value>LLONG_MAX)return nil;
    return @(value);
}
static void captureProgress(id object, SEL selector, id payload) {
    objc_setAssociatedObject(object,&progressKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    if([payload isKindOfClass:NSString.class] && [payload length]<65536) {
        NSArray *fields=[payload componentsSeparatedByString:@"@"];
        if(fields.count>=3) {
            NSNumber *bytes=unsignedField(fields[0]),*speed=unsignedField(fields[1]);
            NSMutableArray *segments=[NSMutableArray array];BOOL valid=bytes && speed;
            for(NSUInteger index=3;index<fields.count;index++) {
                NSArray *pair=[fields[index] componentsSeparatedByString:@"*"];
                NSNumber *start=pair.count==2?unsignedField(pair[0]):nil;
                NSNumber *completed=pair.count==2?unsignedField(pair[1]):nil;
                if(!start || !completed){valid=NO;break;}
                [segments addObject:@{@"start":start,@"completed":completed}];
            }
            if(valid)objc_setAssociatedObject(object,&progressKey,
                @{@"completedBytes":bytes,@"bytesPerSecond":speed,@"segments":segments},OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            else objc_setAssociatedObject(object,&progressKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
    }
    originalProgress(object,selector,payload);
}
static NSUInteger presentationRequests, visibleSamples, completedAuthSheets;
static NSMapTable *authCompletions;
static void (*originalBeginSheet)(id, SEL, NSWindow *, void (^)(NSModalResponse));
static void backgroundSheet(NSWindow *parent, SEL selector, NSWindow *sheet, void (^completion)(NSModalResponse)) {
    if([NSStringFromClass(sheet.windowController.class) isEqual:@"NeatAuthWindow"] && completion) {
        if([authCompletions objectForKey:sheet])abort();
        [authCompletions setObject:[completion copy] forKey:sheet];
        presentationRequests++;
        return;
    }
    originalBeginSheet(parent,selector,sheet,completion);
}
static void (*originalOrder)(id, SEL, NSWindowOrderingMode, NSInteger);
static void backgroundOrder(id window, SEL selector, NSWindowOrderingMode mode, NSInteger relative) {
    if(mode != NSWindowOut) { presentationRequests++; return; }
    originalOrder(window, selector, mode, relative);
}
static int remap(int fd,const struct sockaddr *address,socklen_t size,BOOL connecting) {
    struct sockaddr_in value;
    if(address && address->sa_family==AF_INET && size>=sizeof value) {
        memcpy(&value,address,sizeof value);
        if(ntohs(value.sin_port)==10007) {
            value.sin_port=htons(atoi(getenv("NDM_REUSE_PORT")));
            return connecting?connect(fd,(struct sockaddr *)&value,size):bind(fd,(struct sockaddr *)&value,size);
        }
    }
    return connecting?connect(fd,address,size):bind(fd,address,size);
}
static int isolated_bind(int fd,const struct sockaddr *a,socklen_t n){return remap(fd,a,n,NO);}
static int isolated_connect(int fd,const struct sockaddr *a,socklen_t n){return remap(fd,a,n,YES);}
__attribute__((used)) static struct {const void *replacement;const void *original;} hooks[] __attribute__((section("__DATA,__interpose")))={
    {(void *)isolated_bind,(void *)bind},{(void *)isolated_connect,(void *)connect}};
static id ivarObject(id object,const char *name) {
    Ivar ivar=class_getInstanceVariable([object class],name);
    return ivar && ivar_getTypeEncoding(ivar)[0]=='@'?object_getIvar(object,ivar):nil;
}
static id scalar(id object,NSString *name) {
    SEL selector=NSSelectorFromString(name);
    NSMethodSignature *signature=[object methodSignatureForSelector:selector];
    if(!signature || signature.numberOfArguments!=2)return NSNull.null;
    NSInvocation *call=[NSInvocation invocationWithMethodSignature:signature];
    call.target=object;call.selector=selector;[call invoke];
    const char *type=signature.methodReturnType;
    if(type[0]=='@'){__unsafe_unretained id value=nil;[call getReturnValue:&value];return [value isKindOfClass:NSString.class]||[value isKindOfClass:NSNumber.class]?value:NSNull.null;}
    if(!strcmp(type,"q")){long long value=0;[call getReturnValue:&value];return @(value);}
    if(!strcmp(type,"B") || !strcmp(type,"c")){BOOL value=NO;[call getReturnValue:&value];return @(value);}
    if(!strcmp(type,"d")){double value=0;[call getReturnValue:&value];return isfinite(value)?@(value):NSNull.null;}
    return NSNull.null;
}
static NSDictionary *schema(Class cls) {
    NSMutableDictionary *methods=[NSMutableDictionary dictionary],*ivars=[NSMutableDictionary dictionary];
    unsigned count=0;Method *list=class_copyMethodList(cls,&count);
    for(unsigned i=0;i<count;i++)methods[NSStringFromSelector(method_getName(list[i]))]=@(method_getTypeEncoding(list[i]));
    free(list);Ivar *fields=class_copyIvarList(cls,&count);
    for(unsigned i=0;i<count;i++){
        NSString *type=@(ivar_getTypeEncoding(fields[i]));
        ivars[@(ivar_getName(fields[i]))]=@{@"offset":@(ivar_getOffset(fields[i])),@"type":[type substringToIndex:MIN(type.length,120)]};
    }
    free(fields);return @{@"methods":methods,@"ivars":ivars};
}
static void tick(void) {
    @autoreleasepool { @try {
        id delegate=NSApp.delegate;if(!delegate)return;
        NSDictionary *windows=ivarObject(delegate,"downloadWindows");
        NSString *commandPath=[root stringByAppendingPathComponent:@"command.json"];
        NSData *commandData=[NSData dataWithContentsOfFile:commandPath];
        if(commandData && commandData.length<4096) {
            NSDictionary *command=[NSJSONSerialization JSONObjectWithData:commandData options:0 error:nil];
            [[NSFileManager defaultManager] removeItemAtPath:commandPath error:nil];
            NSMutableDictionary *result=[NSMutableDictionary dictionaryWithDictionary:@{@"ok":@NO,@"nonce":command[@"nonce"]?:@""}];
            NSString *key=command[@"task"],*operation=command[@"operation"];
            id object=nil;
            if([windows isKindOfClass:NSDictionary.class])for(id candidate in windows)if([[candidate description] isEqual:key]){object=windows[candidate];break;}
            if(object && ([operation isEqual:@"pause"]||[operation isEqual:@"resume"])) {
                BOOL working=[scalar(object,@"isWorking") boolValue];
                BOOL desired=[operation isEqual:@"resume"];
                NSMethodSignature *signature=[object methodSignatureForSelector:NSSelectorFromString(@"pauseResume:")];
                if(signature.numberOfArguments==3 && !strcmp(signature.methodReturnType,"v") && [signature getArgumentTypeAtIndex:2][0]=='@') {
                    if(working!=desired) {
                        NSInvocation *call=[NSInvocation invocationWithMethodSignature:signature];
                        call.target=object;call.selector=NSSelectorFromString(@"pauseResume:");
                        id sender=nil;[call setArgument:&sender atIndex:2];[call invoke];
                    }
                    result[@"ok"]=@YES;result[@"workingBefore"]=@(working);
                    result[@"workingAfter"]=scalar(object,@"isWorking");
                }
            }
            if(object && ([operation isEqual:@"cancel-auth"] || [operation isEqual:@"submit-auth"]) && [scalar(object,@"isAuthenticating") boolValue]) {
                id controller=ivarObject(object,"_authWindow");
                NSWindow *sheet=[controller isKindOfClass:NSWindowController.class]?[controller window]:nil;
                void (^completion)(NSModalResponse)=[authCompletions objectForKey:sheet];
                BOOL accepting=[operation isEqual:@"submit-auth"];
                BOOL valid=YES;
                if(accepting) {
                    id username=command[@"username"],password=command[@"password"];
                    NSTextField *userField=ivarObject(controller,"_txtUserName");
                    NSTextField *passField=ivarObject(controller,"_txtPassword");
                    NSButton *remember=ivarObject(controller,"_chkRemember");
                    valid=[username isKindOfClass:NSString.class] && [username length]>0 &&
                        [password isKindOfClass:NSString.class] && [userField isKindOfClass:NSTextField.class] &&
                        [passField isKindOfClass:NSTextField.class] && [remember isKindOfClass:NSButton.class];
                    if(valid) { userField.stringValue=username;passField.stringValue=password;remember.state=NSControlStateValueOff; }
                }
                if(completion && valid) {
                    // Remove before invoking: the original callback may release its controller.
                    [authCompletions removeObjectForKey:sheet];
                    completion(accepting?NSModalResponseOK:NSModalResponseCancel);
                    completedAuthSheets++;
                    result[@"ok"]=@YES;result[@"viaSheetCompletion"]=@YES;
                }
            }
            if(!object && [operation isEqual:@"resume"]) {
                NSArray *records=ivarObject(delegate,"downloadRecords");
                if([records isKindOfClass:NSArray.class])for(NSUInteger index=0;index<records.count;index++) {
                    id record=records[index];
                    if(![record isKindOfClass:NSDictionary.class] || ![[record[@"id"] description] isEqual:key])continue;
                    if([record[@"status"] isEqual:@"Complete"])break;
                    SEL selector=NSSelectorFromString(@"resumeDownload:");
                    NSMethodSignature *signature=[delegate methodSignatureForSelector:selector];
                    if(signature.numberOfArguments==3 && !strcmp(signature.methodReturnType,"v") && !strcmp([signature getArgumentTypeAtIndex:2],"q")) {
                        NSInvocation *call=[NSInvocation invocationWithMethodSignature:signature];call.target=delegate;call.selector=selector;
                        long long row=index;[call setArgument:&row atIndex:2];[call invoke];
                        result[@"ok"]=@YES;result[@"loadedFromRecord"]=@YES;
                    }
                    break;
                }
            }
            [[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:nil]
                writeToFile:[root stringByAppendingPathComponent:@"command-result.json"] atomically:YES];
        }
        NSUInteger visible=0;
        for(NSWindow *window in NSApp.windows)if(window.isVisible)visible++;
        if(visible)visibleSamples++;
        NSMutableArray *tasks=[NSMutableArray array];
        if([windows isKindOfClass:NSDictionary.class])for(id key in windows){
            id object=windows[key];
            [tasks addObject:@{@"key":[key description],@"class":NSStringFromClass([object class]),
                @"engineProgress":objc_getAssociatedObject(object,&progressKey)?:NSNull.null,@"id":scalar(object,@"getDownloadId"),@"working":scalar(object,@"isWorking"),
                @"authenticating":scalar(object,@"isAuthenticating"),@"waiting":scalar(object,@"isWaiting"),@"percent":scalar(object,@"percentCompleted")}];
        }
        id records=ivarObject(delegate,"downloadRecords");
        NSMutableArray *rows=[NSMutableArray array];
        if([records isKindOfClass:NSArray.class])for(id record in records) {
            if([record isKindOfClass:NSDictionary.class]) [rows addObject:@{@"id":record[@"id"]?:NSNull.null,@"status":record[@"status"]?:NSNull.null}];
        }
        NSDictionary *state=@{@"pid":@(getpid()),@"time":@([[NSDate date] timeIntervalSince1970]),
            @"pendingAuthSheets":@(authCompletions.count),@"completedAuthSheets":@(completedAuthSheets),@"headless":@(headless),@"visibleWindows":@(visible),@"visibleSamples":@(visibleSamples),@"presentationRequests":@(presentationRequests),
            @"delegate":NSStringFromClass([delegate class]),@"support":ivarObject(delegate,"nsAppSupportPath")?:NSNull.null,
            @"output":ivarObject(delegate,"nsAppOutputPath")?:NSNull.null,@"tasks":tasks,
            @"records":rows,@"recordCount":@([records respondsToSelector:@selector(count)]?[records count]:0)};
        NSData *data=[NSJSONSerialization dataWithJSONObject:state options:NSJSONWritingPrettyPrinted error:nil];
        [data writeToFile:[root stringByAppendingPathComponent:@"snapshot.json"] atomically:YES];
        NSString *schemaPath=[root stringByAppendingPathComponent:@"schema.json"];
        if(![[NSFileManager defaultManager] fileExistsAtPath:schemaPath]) {
            NSMutableDictionary *types=[NSMutableDictionary dictionary];
            for(NSString *name in @[@"AppDelegate",@"NeatDownloadWindow",@"NeatAuthWindow",@"NeatURLWindow",@"NeatDownloadRecord"]){
                Class cls=NSClassFromString(name);if(cls)types[name]=schema(cls);
            }
            [[NSJSONSerialization dataWithJSONObject:types options:NSJSONWritingPrettyPrinted error:nil] writeToFile:schemaPath atomically:YES];
        }
    } @catch(NSException *error){fprintf(stderr,"reuse probe: %s\n",error.name.UTF8String);} }
}
__attribute__((constructor)) static void loaded(void) {
    const char *path=getenv("NDM_REUSE_DIR"),*port=getenv("NDM_REUSE_PORT");
    if(!path||!port||atoi(port)<1024)abort();
    root=[[NSString alloc] initWithUTF8String:path];
    headless=getenv("NDM_REUSE_HEADLESS") && !strcmp(getenv("NDM_REUSE_HEADLESS"),"1");
    if(headless) {
        Method method=class_getInstanceMethod(NSWindow.class,@selector(orderWindow:relativeTo:));
        NSMethodSignature *signature=[NSWindow instanceMethodSignatureForSelector:@selector(orderWindow:relativeTo:)];
        if(signature.numberOfArguments!=4 || strcmp(signature.methodReturnType,"v") ||
           strcmp([signature getArgumentTypeAtIndex:2],"q") || strcmp([signature getArgumentTypeAtIndex:3],"q"))abort();
        originalOrder=(void *)method_setImplementation(method,(IMP)backgroundOrder);
        authCompletions=[NSMapTable strongToStrongObjectsMapTable];
        SEL selector=@selector(beginSheet:completionHandler:);
        signature=[NSWindow instanceMethodSignatureForSelector:selector];
        if(signature.numberOfArguments!=4 || strcmp(signature.methodReturnType,"v") ||
           strcmp([signature getArgumentTypeAtIndex:2],"@") || strcmp([signature getArgumentTypeAtIndex:3],"@?"))abort();
        originalBeginSheet=(void *)method_setImplementation(class_getInstanceMethod(NSWindow.class,selector),(IMP)backgroundSheet);
    }
    dispatch_async(dispatch_get_main_queue(),^{
        Class cls=NSClassFromString(@"NeatDownloadWindow");
        SEL selector=NSSelectorFromString(@"handleEngineNotifyDownload:");
        NSMethodSignature *signature=[cls instanceMethodSignatureForSelector:selector];
        if(signature.numberOfArguments!=3 || strcmp(signature.methodReturnType,"v") || strcmp([signature getArgumentTypeAtIndex:2],"@"))abort();
        originalProgress=(void *)method_setImplementation(class_getInstanceMethod(cls,selector),(IMP)captureProgress);
        timer=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());
        dispatch_source_set_timer(timer,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),NSEC_PER_SEC/5,NSEC_PER_SEC/20);
        dispatch_source_set_event_handler(timer,^{tick();});dispatch_resume(timer);
    });
}
