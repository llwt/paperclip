import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  DELETE_CHARACTER_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  type ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { $unwrapQuoteAtStart, registerQuoteExit } from "./quote-exit";

/**
 * These run the real `QuoteNode` and the real rich-text Enter and Backspace
 * handlers, because the bug is in how the two interact. `@lexical/rich-text`
 * is not a dependency of the app, so load the ES module copy MDXEditor
 * resolves; that copy shares the `lexical` instance this file imports.
 */
interface RichText {
  QuoteNode: Klass<LexicalNode>;
  $createQuoteNode: () => ElementNode;
  registerRichText: (editor: LexicalEditor) => () => void;
}

let richText: RichText;

beforeAll(async () => {
  const requireFromUi = createRequire(import.meta.url);
  const requireFromMdxEditor = createRequire(requireFromUi.resolve("@mdxeditor/editor"));
  const richTextDir = dirname(requireFromMdxEditor.resolve("@lexical/rich-text"));
  richText = (await import(
    /* @vite-ignore */ pathToFileURL(join(richTextDir, "LexicalRichText.mjs")).href
  )) as RichText;
});

function createTestEditor(withQuoteExit = true) {
  const editor = createEditor({
    namespace: "quote-exit-test",
    nodes: [richText.QuoteNode],
    onError(error: Error) {
      throw error;
    },
  });
  richText.registerRichText(editor);
  if (withQuoteExit) registerQuoteExit(editor);
  return editor;
}

function update(editor: LexicalEditor, fn: () => void) {
  editor.update(fn, { discrete: true });
}

/** Compact picture of the document: `quote[p(a) p()] p(b)`. */
function shape(editor: LexicalEditor): string {
  function describeNode(node: LexicalNode): string {
    const type = node.getType();
    if (type === "text") return node.getTextContent();
    if (type === "linebreak") return "\\n";
    const label = type === "paragraph" ? "p" : type;
    const children = (node as ElementNode).getChildren().map(describeNode);
    return label === "p" ? `p(${children.join("")})` : `${label}[${children.join(" ")}]`;
  }
  return editor.getEditorState().read(() => $getRoot().getChildren().map(describeNode).join(" "));
}

/** Where the caret sits: the type of its block and of that block's parent. */
function caret(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return "none";
    let node: LexicalNode = selection.anchor.getNode();
    while (node.getType() === "text" || node.getType() === "linebreak") node = node.getParentOrThrow();
    return `${node.getParentOrThrow().getType()}>${node.getType()}`;
  });
}

/** A quote as the markdown importer builds it: one paragraph per quoted paragraph. */
function loadQuote(editor: LexicalEditor, paragraphs: string[], options: { before?: string; after?: string } = {}) {
  update(editor, () => {
    const root = $getRoot();
    root.clear();
    if (options.before !== undefined) {
      root.append($createParagraphNode().append($createTextNode(options.before)));
    }
    const quote = richText.$createQuoteNode();
    for (const text of paragraphs) {
      const paragraph = $createParagraphNode();
      if (text) paragraph.append($createTextNode(text));
      quote.append(paragraph);
    }
    root.append(quote);
    if (options.after !== undefined) {
      root.append($createParagraphNode().append($createTextNode(options.after)));
    }
    quote.getLastChildOrThrow<ElementNode>().selectEnd();
  });
}

/**
 * A quote as the `> ` shortcut builds it: the text sits directly in the quote.
 * With the plugin registered it is wrapped into a paragraph as the update ends.
 */
function typeQuote(editor: LexicalEditor, text: string) {
  update(editor, () => {
    const root = $getRoot();
    root.clear();
    const quote = richText.$createQuoteNode();
    if (text) quote.append($createTextNode(text));
    root.append(quote);
    quote.selectEnd();
  });
}

function selectQuoteParagraph(editor: LexicalEditor, index: number, edge: "start" | "end") {
  update(editor, () => {
    const quote = $getRoot().getChildren().find((node) => node.getType() === "quote") as ElementNode;
    const paragraph = quote.getChildAtIndex<ElementNode>(index);
    if (!paragraph) throw new Error(`No quote paragraph at ${index}`);
    if (edge === "start") paragraph.selectStart();
    else paragraph.selectEnd();
  });
}

function pressEnter(editor: LexicalEditor) {
  update(editor, () => {
    editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
  });
}

function pressShiftEnter(editor: LexicalEditor) {
  update(editor, () => {
    editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
  });
}

function pressBackspace(editor: LexicalEditor) {
  update(editor, () => {
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
  });
}

function declinesBackspace(editor: LexicalEditor): boolean {
  let handled = true;
  update(editor, () => {
    handled = $unwrapQuoteAtStart();
  });
  return !handled;
}

function type(editor: LexicalEditor, text: string) {
  update(editor, () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) throw new Error("Expected a range selection to type into");
    selection.insertText(text);
  });
}

describe("quote exit", () => {
  describe("without the plugin", () => {
    it("traps the caret in a quote loaded from markdown", () => {
      const editor = createTestEditor(false);
      loadQuote(editor, ["quoted"]);

      pressEnter(editor);
      pressEnter(editor);
      type(editor, "reply");

      expect(shape(editor)).toBe("quote[p(quoted) p() p(reply)]");
    });

    it("drops out of a quote typed with the shortcut on the first Enter", () => {
      const editor = createTestEditor(false);
      typeQuote(editor, "quoted");

      pressEnter(editor);
      type(editor, "more");

      expect(shape(editor)).toBe("quote[quoted] p(more)");
    });
  });

  describe("typed quote shape", () => {
    it("wraps the text of a typed quote in a paragraph and keeps the caret", () => {
      const editor = createTestEditor();
      typeQuote(editor, "quoted");

      expect(shape(editor)).toBe("quote[p(quoted)]");
      expect(caret(editor)).toBe("quote>paragraph");

      type(editor, "!");
      expect(shape(editor)).toBe("quote[p(quoted!)]");
    });

    it("gives an empty typed quote an empty paragraph holding the caret", () => {
      const editor = createTestEditor();
      typeQuote(editor, "");

      expect(shape(editor)).toBe("quote[p()]");
      expect(caret(editor)).toBe("quote>paragraph");

      type(editor, "quoted");
      expect(shape(editor)).toBe("quote[p(quoted)]");
    });

    it("keeps formatted text and line breaks together on one line", () => {
      const editor = createTestEditor();
      update(editor, () => {
        const quote = richText.$createQuoteNode();
        quote.append(
          $createTextNode("bold").toggleFormat("bold"),
          $createTextNode(" first"),
          $createLineBreakNode(),
          $createTextNode("second"),
        );
        $getRoot().clear().append(quote);
        quote.selectEnd();
      });

      expect(shape(editor)).toBe("quote[p(bold first\\nsecond)]");
    });

    it("keeps a caret that sits between the children of the quote", () => {
      const editor = createTestEditor();
      update(editor, () => {
        const quote = richText.$createQuoteNode();
        quote.append($createTextNode("first"), $createLineBreakNode());
        $getRoot().clear().append(quote);
        quote.select(2, 2);
      });

      type(editor, "second");

      expect(shape(editor)).toBe("quote[p(first\\nsecond)]");
    });

    it("wraps loose text next to a paragraph without touching the paragraph", () => {
      const editor = createTestEditor();
      update(editor, () => {
        const quote = richText.$createQuoteNode();
        quote.append(
          $createTextNode("loose"),
          $createParagraphNode().append($createTextNode("kept")),
          $createTextNode("tail"),
        );
        $getRoot().clear().append(quote);
        quote.selectEnd();
      });

      expect(shape(editor)).toBe("quote[p(loose) p(kept) p(tail)]");
      expect(caret(editor)).toBe("quote>paragraph");

      type(editor, "!");
      expect(shape(editor)).toBe("quote[p(loose) p(kept) p(tail!)]");
    });

    it("leaves a loaded quote as it is", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["first", "second"]);

      expect(shape(editor)).toBe("quote[p(first) p(second)]");
    });
  });

  describe("Enter", () => {
    it("leaves a loaded quote from its empty last line", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["quoted"]);

      pressEnter(editor);
      expect(shape(editor)).toBe("quote[p(quoted) p()]");
      expect(caret(editor)).toBe("quote>paragraph");

      pressEnter(editor);
      expect(shape(editor)).toBe("quote[p(quoted)] p()");
      expect(caret(editor)).toBe("root>paragraph");

      type(editor, "reply");
      expect(shape(editor)).toBe("quote[p(quoted)] p(reply)");
    });

    it("leaves a quote that holds several paragraphs", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["first", "second"]);

      pressEnter(editor);
      pressEnter(editor);
      type(editor, "reply");

      expect(shape(editor)).toBe("quote[p(first) p(second)] p(reply)");
    });

    it("puts the new paragraph between the quote and what follows it", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["quoted"], { before: "intro", after: "after" });

      pressEnter(editor);
      pressEnter(editor);
      type(editor, "reply");

      expect(shape(editor)).toBe("p(intro) quote[p(quoted)] p(reply) p(after)");
    });

    it("continues a typed quote on a non-empty line", () => {
      const editor = createTestEditor();
      typeQuote(editor, "first");

      pressEnter(editor);
      expect(caret(editor)).toBe("quote>paragraph");

      type(editor, "second");
      expect(shape(editor)).toBe("quote[p(first) p(second)]");
    });

    it("leaves a typed quote from its empty last line", () => {
      const editor = createTestEditor();
      typeQuote(editor, "quoted");

      pressEnter(editor);
      expect(shape(editor)).toBe("quote[p(quoted) p()]");
      expect(caret(editor)).toBe("quote>paragraph");

      pressEnter(editor);
      expect(shape(editor)).toBe("quote[p(quoted)] p()");
      expect(caret(editor)).toBe("root>paragraph");

      type(editor, "reply");
      expect(shape(editor)).toBe("quote[p(quoted)] p(reply)");
    });

    it("splits a typed quote line in two when Enter is pressed inside it", () => {
      const editor = createTestEditor();
      typeQuote(editor, "firstsecond");
      update(editor, () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
        selection.anchor.offset = 5;
        selection.focus.offset = 5;
      });

      pressEnter(editor);

      expect(shape(editor)).toBe("quote[p(first) p(second)]");
      expect(caret(editor)).toBe("quote>paragraph");
    });

    it("turns a quote with nothing in it into a paragraph", () => {
      const editor = createTestEditor();
      typeQuote(editor, "");

      pressEnter(editor);
      type(editor, "reply");

      expect(shape(editor)).toBe("p(reply)");
    });

    it("turns a loaded quote that was emptied into a paragraph", () => {
      const editor = createTestEditor();
      loadQuote(editor, [""]);

      pressEnter(editor);
      type(editor, "reply");

      expect(shape(editor)).toBe("p(reply)");
    });

    it("continues the quote on a non-empty line", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["quoted"]);

      pressEnter(editor);
      type(editor, "more");

      expect(shape(editor)).toBe("quote[p(quoted) p(more)]");
    });

    it("stays in the quote on an empty line that is not the last one", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["first", "", "last"]);
      selectQuoteParagraph(editor, 1, "start");

      pressEnter(editor);

      expect(shape(editor)).toBe("quote[p(first) p() p() p(last)]");
      expect(caret(editor)).toBe("quote>paragraph");
    });

    it("stays in the quote on a last line that only holds a line break", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["quoted"]);
      pressEnter(editor);
      update(editor, () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
        selection.insertNodes([$createLineBreakNode()]);
      });

      pressEnter(editor);

      expect(caret(editor)).toBe("quote>paragraph");
    });

    it("leaves Shift+Enter as a line break inside the quote", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["quoted"]);

      pressShiftEnter(editor);
      type(editor, "more");

      expect(shape(editor)).toBe("quote[p(quoted\\nmore)]");
    });

    it("does not touch an empty paragraph outside a quote", () => {
      const editor = createTestEditor();
      update(editor, () => {
        const paragraph = $createParagraphNode();
        $getRoot().clear().append($createParagraphNode().append($createTextNode("a")), paragraph);
        paragraph.select();
      });

      pressEnter(editor);

      expect(shape(editor)).toBe("p(a) p() p()");
    });
  });

  describe("Backspace", () => {
    it("turns an empty loaded quote into a paragraph", () => {
      const editor = createTestEditor();
      loadQuote(editor, [""], { before: "intro" });

      pressBackspace(editor);
      expect(shape(editor)).toBe("p(intro) p()");
      expect(caret(editor)).toBe("root>paragraph");

      type(editor, "reply");
      expect(shape(editor)).toBe("p(intro) p(reply)");
    });

    it("lifts the paragraphs out when pressed at the start of the quote", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["first", "second"], { before: "intro" });
      selectQuoteParagraph(editor, 0, "start");

      pressBackspace(editor);

      expect(shape(editor)).toBe("p(intro) p(first) p(second)");
      expect(caret(editor)).toBe("root>paragraph");
    });

    it("turns an empty typed quote into a paragraph", () => {
      const editor = createTestEditor();
      typeQuote(editor, "");

      pressBackspace(editor);
      expect(shape(editor)).toBe("p()");
      expect(caret(editor)).toBe("root>paragraph");

      type(editor, "reply");
      expect(shape(editor)).toBe("p(reply)");
    });

    it("lifts the line out when pressed at the start of a typed quote", () => {
      const editor = createTestEditor();
      typeQuote(editor, "quoted");
      selectQuoteParagraph(editor, 0, "start");

      pressBackspace(editor);

      expect(shape(editor)).toBe("p(quoted)");
      expect(caret(editor)).toBe("root>paragraph");
    });

    it("merges an empty line of a typed quote into the one above it", () => {
      const editor = createTestEditor();
      typeQuote(editor, "first");
      pressEnter(editor);

      pressBackspace(editor);
      expect(shape(editor)).toBe("quote[p(first)]");
      expect(caret(editor)).toBe("quote>paragraph");

      type(editor, "more");
      expect(shape(editor)).toBe("quote[p(firstmore)]");
    });

    // Lexical's own character deletion needs a mounted DOM, so this checks
    // that the handler declines and leaves the key to the editor.
    it("leaves a caret inside the first quote line to the editor", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["first"]);

      expect(declinesBackspace(editor)).toBe(true);
      expect(shape(editor)).toBe("quote[p(first)]");
    });

    it("merges a later quote line into the one above it", () => {
      const editor = createTestEditor();
      loadQuote(editor, ["first", "second"]);
      selectQuoteParagraph(editor, 1, "start");

      pressBackspace(editor);

      expect(shape(editor)).toBe("quote[p(firstsecond)]");
    });
  });
});
