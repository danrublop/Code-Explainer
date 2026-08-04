// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { markdownToSafeHtml } from './chat-message-body';

describe('chat message markdown rendering', () => {
  it('renders common markdown to rich HTML', () => {
    const html = markdownToSafeHtml('**bold** and `code`\n\n- one\n- two');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>');
  });

  it('renders a fenced code block', () => {
    expect(markdownToSafeHtml('```\nx = 1\n```')).toContain('<pre>');
  });

  it('strips dangerous HTML from untrusted model output', () => {
    const html = markdownToSafeHtml('hi <img src=x onerror=alert(1)> <script>alert(2)</script>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
  });
});
