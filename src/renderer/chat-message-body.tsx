import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './editor/extensions';

// Render an assistant message's Markdown as rich text. Model output is UNTRUSTED, so we go through
// the SAME @tiptap/markdown → ProseMirror schema the note editor uses (which drops any node/attr
// it doesn't recognize) and then DOMPurify — the one sanctioned raw-HTML path (see CLAUDE.md).
// One shared headless editor is reused across every message (setContent per call) instead of one
// instance per bubble, mirroring reconstruct.ts. User turns stay plain text (see the callers).

let shared: Editor | null = null;

export function markdownToSafeHtml(md: string): string {
  shared ??= new Editor({ extensions: notebookExtensions() });
  shared.commands.setContent(md, { contentType: 'markdown' } as never);
  return DOMPurify.sanitize(shared.getHTML());
}

export function MessageBody({ markdown, className = 'chat-text' }: { markdown: string; className?: string }) {
  // Recompute only when the text changes. On any failure fall back to plain text — a rendering
  // hiccup must never blank out the user's answer.
  const html = useMemo(() => { try { return markdownToSafeHtml(markdown); } catch { return null; } }, [markdown]);
  if (html == null) return <div className={className}>{markdown}</div>;
  return <div className={`${className} md`} dangerouslySetInnerHTML={{ __html: html }} />;
}
