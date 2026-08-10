#pragma once

#include "SpegMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using SpegMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<SpegMarkdownTextShadowNode>;

void SpegMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
