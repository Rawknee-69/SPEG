#pragma once

#include <react/renderer/components/SpegMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/SpegMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char SpegMarkdownTextComponentName[];

struct SpegMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct SpegMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float SpegMarkdownTextAttachmentSize(const SpegMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float SpegMarkdownTextAttachmentBaselineOffset(
    const SpegMarkdownTextAttachmentRange &) {
  return -2;
}

class SpegMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<SpegMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<SpegMarkdownTextAttachmentRange> attachmentRanges;
};

class SpegMarkdownTextShadowNode final : public ConcreteViewShadowNode<
SpegMarkdownTextComponentName,
SpegMarkdownTextProps,
SpegMarkdownTextEventEmitter,
SpegMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  SpegMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<SpegMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<SpegMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
