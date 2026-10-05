/*
 * Markdown from the update server (release notes, announcements) is rendered
 * with v-html, so sanitize the generated HTML: no scripts, event handlers,
 * javascript: URLs or other active content can reach the webview (which has
 * IPC access). marked + DOMPurify are only loaded when there is something to
 * render.
 */
export async function renderRemoteMarkdown(body: string): Promise<string> {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import("marked"),
    import("dompurify"),
  ]);

  const mdRenderer = new marked.Renderer();
  mdRenderer.link = function (this: typeof mdRenderer, { href, tokens }) {
    const text = this.parser.parseInline(tokens);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  };

  const html = marked.parse(body, {
    renderer: mdRenderer,
    async: false,
  }) as string;

  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style", "form", "input", "button", "iframe"],
  });
}
