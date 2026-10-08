import { createRootEditorSubscription$, realmPlugin } from "@mdxeditor/editor";
import {
  $createParagraphNode,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  DELETE_CHARACTER_COMMAND,
  getRegisteredNode,
  INSERT_PARAGRAPH_COMMAND,
  type ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

/**
 * Keyboard behaviour for quote blocks.
 *
 * A quote that came from markdown (a saved comment, a restored draft, a
 * markdown paste) holds paragraphs. A quote typed with the `> ` shortcut holds
 * its text directly, and Lexical steps out of that shape on the first Enter,
 * so a second quoted line could not be typed. Typed quotes are therefore
 * given the paragraph shape as soon as they appear, and both kinds follow the
 * same rules: Enter on a line with text continues the quote, Enter on an empty
 * last line leaves it, and Backspace at the start of the quote dissolves it.
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
 * Gives a quote the shape the markdown importer builds: every line sits in a
 * paragraph. Runs of inline children are wrapped where they stand and an empty
 * quote gets one empty paragraph, with the caret kept in place.
 */
export function $wrapQuoteInlineChildren(quote: ElementNode): void {
  const children = quote.getChildren();
  const runs: { start: number; nodes: LexicalNode[] }[] = [];
  let run: LexicalNode[] | null = null;
  children.forEach((child, index) => {
    if ($isElementNode(child) && !child.isInline()) {
      run = null;
    } else if (run) {
      run.push(child);
    } else {
      run = [child];
      runs.push({ start: index, nodes: run });
    }
  });
  if (runs.length === 0 && children.length > 0) return;

  // A caret anchored on the quote itself counts its children; note which child
  // it sits before so it can follow that child into the paragraph.
  const selection = $getSelection();
  const points = $isRangeSelection(selection)
    ? [selection.anchor, selection.focus].filter((point) => point.type === "element" && point.key === quote.getKey())
    : [];
  const pointOffsets = points.map((point) => point.offset);

  if (children.length === 0) {
    const paragraph = $createParagraphNode();
    quote.append(paragraph);
    for (const point of points) point.set(paragraph.getKey(), 0, "element");
    return;
  }

  const paragraphs = runs.map(({ nodes }) => {
    const paragraph = $createParagraphNode();
    nodes[0].insertBefore(paragraph);
    paragraph.append(...nodes);
    return paragraph;
  });

  // Every offset was counted before any run was wrapped, so each point is
  // placed once from those counts: into the run it touched, or else on the
  // quote, moved back by the children the earlier runs folded away.
  points.forEach((point, index) => {
    const offset = pointOffsets[index];
    const runIndex = runs.findIndex(({ start, nodes }) => offset >= start && offset <= start + nodes.length);
    if (runIndex !== -1) {
      point.set(paragraphs[runIndex].getKey(), offset - runs[runIndex].start, "element");
      return;
    }
    const folded = runs
      .filter(({ start }) => start < offset)
      .reduce((count, { nodes }) => count + nodes.length - 1, 0);
    point.set(quote.getKey(), offset - folded, "element");
  });
}

/**
 * Enter on an empty last line of a quote moves that line out, below the quote,
 * as a normal paragraph. Returns false when the caret is anywhere else so the
 * editor's own Enter handling runs, which adds the next line inside the quote.
 */
export function $exitQuoteOnEmptyLastLine(): boolean {
  const block = $getCaretBlock();
  if (!block || !block.isEmpty()) return false;

  const quote = block.getParent();
  if (!$isParagraphNode(block) || !quote || !$isQuote(quote) || block.getNextSibling() !== null) return false;

  quote.insertAfter(block);
  if (quote.isEmpty()) quote.remove();
  block.select();
  return true;
}

/**
 * Backspace at the very start of a quote dissolves the quote and leaves its
 * paragraphs in place.
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
  // Absent when the editor runs without the quote plugin.
  const quoteKlass = getRegisteredNode(editor, QUOTE_NODE_TYPE)?.klass as Klass<ElementNode> | undefined;
  const unregisterTransform = quoteKlass
    ? editor.registerNodeTransform(quoteKlass, $wrapQuoteInlineChildren)
    : () => {};
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
    unregisterTransform();
    unregisterEnter();
    unregisterBackspace();
  };
}

export const quoteExitPlugin = realmPlugin({
  init(realm) {
    realm.pub(createRootEditorSubscription$, [registerQuoteExit]);
  },
});
