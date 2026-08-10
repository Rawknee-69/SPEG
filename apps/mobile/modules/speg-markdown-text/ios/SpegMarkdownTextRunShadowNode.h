#pragma once

#include <react/renderer/components/SpegMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/SpegMarkdownTextSpec/Props.h>
#include <react/renderer/components/SpegMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char SpegMarkdownTextRunComponentName[];

using SpegMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    SpegMarkdownTextRunComponentName,
    SpegMarkdownTextRunProps,
    SpegMarkdownTextRunEventEmitter,
    SpegMarkdownTextRunState>;
}
