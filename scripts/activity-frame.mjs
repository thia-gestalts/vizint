import { escapeHTML } from './learning-pages.mjs';

// JSON inside <script> must not close the element.
const scriptJSON = value => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * A view as one self-contained HTML document. Everything it needs is inline,
 * apart from dataset packs it may fetch from `connect` origins.
 */
export function activityFrame({
  title, common, libraryStyles = '', styles, markup, code, media, context, packs = [], connect = [],
}) {
  const policy = [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    ...(libraryStyles ? ['font-src data:'] : []),
    ...(media ? ['media-src blob:'] : []),
    ...(connect.length ? [`connect-src ${connect.join(' ')}`] : []),
    "form-action 'none'", "base-uri 'none'",
  ].join('; ');
  const data = [
    context ? `<script type="application/json" id="vizint-view">${scriptJSON(context)}</script>` : '',
    ...packs.map(({ id, base64 }) => `<script type="application/octet-stream" id="${escapeHTML(id)}">${base64}</script>`),
  ].join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHTML(policy)}">
<title>${escapeHTML(title)}</title><style>${libraryStyles}\n${common}\n${styles}</style></head>
<body>${markup}${data}<script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
