#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface SpegMarkdownTextManager : RCTViewManager
@end

@implementation SpegMarkdownTextManager

RCT_EXPORT_MODULE(SpegMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface SpegMarkdownTextRunManager : RCTViewManager
@end

@implementation SpegMarkdownTextRunManager

RCT_EXPORT_MODULE(SpegMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
