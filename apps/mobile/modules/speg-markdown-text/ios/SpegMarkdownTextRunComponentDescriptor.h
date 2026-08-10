#pragma once

#include "SpegMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using SpegMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<SpegMarkdownTextRunShadowNode>;

void SpegMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
