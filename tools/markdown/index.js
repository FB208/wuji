import { marked } from "marked";
import { decodeHTML } from "entities";

/** 构造小程序富文本元素，样式直接附在节点上以适配组件隔离。 */
function element(name, children, style = "", attrs = {}) {
  return { name, attrs: { ...attrs, style }, children };
}

/** 文本节点保持原始字符，代码内容不进行 HTML 实体转换。 */
function text(value, literal = false) {
  return { type: "text", text: literal ? value : decodeHTML(value) };
}

/** 将 Markdown 语法树映射为富文本节点，HTML 片段只作为文字显示。 */
function render(tokens) {
  const nodes = [];
  for (const token of tokens) {
    const children = () => token.tokens ? render(token.tokens) : [text(token.text || "")];
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "paragraph":
        nodes.push(element("p", children(), "margin:0 0 0.65em;"));
        break;
      case "heading":
        nodes.push(element("div", children(),
          `font-weight:700;font-size:${[1.4, 1.25, 1.15, 1.05, 1, 1][token.depth - 1]}em;margin:0.6em 0 0.4em;`));
        break;
      case "strong":
        nodes.push(element("strong", children(), "font-weight:700;"));
        break;
      case "em":
        nodes.push(element("em", children(), "font-style:italic;"));
        break;
      case "del":
        nodes.push(element("del", children(), "text-decoration:line-through;"));
        break;
      case "codespan":
        nodes.push(element("code", [text(token.text, true)],
          "font-family:monospace;background:#f0eee7;padding:0.1em 0.3em;border-radius:4px;"));
        break;
      case "code":
        nodes.push(element("pre", [text(token.text, true)],
          "margin:0.6em 0;padding:0.7em;background:#f0eee7;border-radius:6px;font-family:monospace;font-size:0.9em;white-space:pre-wrap;overflow-wrap:anywhere;"));
        break;
      case "blockquote":
        nodes.push(element("blockquote", children(),
          "margin:0.6em 0;padding:0.1em 0 0.1em 0.7em;border-left:3px solid #c2bdac;color:#656052;"));
        break;
      case "list":
        // 使用显式序号，避免各端 rich-text 对 ol 起始序号支持不一致。
        nodes.push(element("div", token.items.map((item, index) => {
          const marker = item.task ? (item.checked ? "☑" : "☐") :
            token.ordered ? `${Number(token.start) + index}.` : "•";
          return element("div", [
            element("span", [text(marker)], "position:absolute;left:0;top:0;"),
            ...render(item.tokens),
          ], "position:relative;padding-left:1.7em;margin:0.25em 0;");
        }), "margin:0.5em 0;"));
        break;
      case "table": {
        const cell = (value, header) => element(header ? "th" : "td", render(value.tokens),
          `border:1px solid #d6d1c3;padding:0.35em;text-align:${value.align || "left"};${header ? "background:#f0eee7;font-weight:700;" : ""}`);
        nodes.push(element("table", [
          element("tr", token.header.map((value) => cell(value, true))),
          ...token.rows.map((row) => element("tr", row.map((value) => cell(value, false)))),
        ], "width:100%;table-layout:fixed;border-collapse:collapse;margin:0.6em 0;font-size:0.9em;"));
        break;
      }
      case "link":
        nodes.push(element("span", children(), "text-decoration:underline;"));
        break;
      case "image":
        nodes.push(text(token.text || token.href));
        break;
      case "br":
        nodes.push(element("br", []));
        break;
      case "hr":
        nodes.push(element("hr", [], "border:0;border-top:1px solid #d6d1c3;margin:0.8em 0;"));
        break;
      case "text":
        nodes.push(...children());
        break;
      case "escape":
      case "html":
        nodes.push(text(token.text, true));
        break;
      default:
        throw new Error(`未支持的 Markdown 语法：${token.type}`);
    }
  }
  return nodes;
}

/** 完整消息和流式草稿使用同一解析入口，支持 GFM 列表、表格等语法。 */
export function markdownNodes(source) {
  return render(marked.lexer(source || "", { gfm: true, breaks: true }));
}
