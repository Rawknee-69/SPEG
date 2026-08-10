import {
  SelectableMarkdownText as SpegSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@speg/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@speg/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return <SpegSelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}
