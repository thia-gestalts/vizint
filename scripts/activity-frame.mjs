import { escapeHTML } from './learning-pages.mjs';

export function activityFrame({ title, common, libraryStyles = '', styles, markup, code, media }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';${libraryStyles ? ' font-src data:;' : ''}${media ? ' media-src blob:;' : ''} form-action 'none'; base-uri 'none'">
<title>${escapeHTML(title)}</title><style>${libraryStyles}\n${common}\n${styles}</style></head>
<body>${markup}<script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
