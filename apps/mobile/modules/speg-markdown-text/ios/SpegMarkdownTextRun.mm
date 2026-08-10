#import "SpegMarkdownTextRun.h"
#import "SpegMarkdownText.h"
#import "SpegMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/SpegMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/SpegMarkdownTextSpec/Props.h>
#import <react/renderer/components/SpegMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface SpegMarkdownTextRun () <RCTSpegMarkdownTextRunViewProtocol>

@end

@implementation SpegMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<SpegMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const SpegMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<SpegMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<SpegMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::SpegMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::SpegMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::SpegMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::SpegMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> SpegMarkdownTextRunCls(void)
{
    return SpegMarkdownTextRun.class;
}

@end
