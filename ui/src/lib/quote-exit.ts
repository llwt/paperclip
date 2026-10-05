import { createRootEditorSubscription$, realmPlugin } from "@mdxeditor/editor";
import {
  $createParagraphNode,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  DELETE_CHARACTER_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

/**
 * Keyboard exits for quote blocks.
 *
 * A quote typed with the `> ` shortcut holds its text directly, and Lexical
 * already steps out of that shape on Enter. A quote that came from markdown
 * (a saved comment, a restored draft, a markdown paste) holds paragraphs
 * instead. There Enter only adds another paragraph inside the quote and
 * Backspace on an emptied quote nests a paragraph in a paragraph, so the
 * caret can never leave and whatever is typed next is saved with a `>`.
 *
 * Matched by node type rather than `$isQuoteNode` so the app does not need its
 * own `@lexical/rich-text` dependency next to the copy MDXEditor resolves.
 */
const QUOTE_NODE_TYPE = "quote";

function $isQuote(node: ElementNode): boolean {
  return node.getType() === QUOTE_NODE_TYPE;
}

/** The block element holding the collapsed caret, or null for any other selection. */
function $getCaretBlock(): ElementNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

  let node: LexicalNode | null = selection.anchor.getNode();
  while (node) {
    if ($isElementNode(node) && !node.isInline()) return node;
    node = node.getParent();
  }
  return null;
}

/**
 * Enter on an empty last line of a quote moves that line out, below the quote,
 * as a normal paragraph. Returns false when the caret is anywhere else so the
 * editor's own Enter handling runs.
 */
export function $exitQuoteOnEmptyLastLine(): boolean {
  const block = $getCaretBlock();
  if (!block || !block.isEmpty()) return false;

  // `> ` followed by Enter: the quote itself is the empty line.
  if ($isQuote(block)) {
    const paragraph = $createParagraphNode();
    block.replace(paragraph);
    paragraph.select();
    return true;
  }

  const quote = block.getParent();
  if (!$isParagraphNode(block) || !quote || !$isQuote(quote) || block.getNextSibling() !== null) return false;

  quote.insertAfter(block);
  if (quote.isEmpty()) quote.remove();
  block.select();
  return true;
}

/**
 * Backspace at the very start of a quote that holds paragraphs dissolves the
 * quote and leaves its paragraphs in place, matching what a typed quote does.
 */
export function $unwrapQuoteAtStart(): boolean {
  const selection = $getSelection();
  const block = $getCaretBlock();
  if (!block || !$isRangeSelection(selection) || selection.anchor.offset !== 0) return false;

  const quote = block.getParent();
  if (!$isParagraphNode(block) || !quote || !$isQuote(quote) || block.getPreviousSibling() !== null) return false;

  // Offset 0 only means the start of the line when nothing sits before the
  // anchor inside the paragraph.
  let node: LexicalNode = selection.anchor.getNode();
  while (!node.is(block)) {
    if (node.getPreviousSibling() !== null) return false;
    node = node.getParentOrThrow();
  }

  for (const child of quote.getChildren()) {
    quote.insertBefore(child);
  }
  quote.remove();
  block.selectStart();
  return true;
}

export function registerQuoteExit(editor: LexicalEditor): () => void {
  const unregisterEnter = editor.registerCommand(
    INSERT_PARAGRAPH_COMMAND,
    () => $exitQuoteOnEmptyLastLine(),
    COMMAND_PRIORITY_HIGH,
  );
  const unregisterBackspace = editor.registerCommand(
    DELETE_CHARACTER_COMMAND,
    (isBackward) => (isBackward ? $unwrapQuoteAtStart() : false),
    COMMAND_PRIORITY_HIGH,
  );

  return () => {
    unregisterEnter();
    unregisterBackspace();
  };
}

export const quoteExitPlugin = realmPlugin({
  init(realm) {
    realm.pub(createRootEditorSubscription$, [registerQuoteExit]);
  },
});
