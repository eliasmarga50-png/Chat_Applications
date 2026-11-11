import sanitizeHtml from 'sanitize-html';
import { randomBytes } from 'node:crypto';

const HTML_OPTIONS = {
  allowedTags: [
    'a', 'b', 'blockquote', 'br', 'code',
    'del', 'div', 'em', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'li',
    'ol', 'p', 'pre', 's', 'span',
    'strong', 'sub', 'sup', 'table',
    'tbody', 'td', 'th', 'thead', 'tr',
    'u', 'ul',
  ],

  allowedAttributes: {
    a: ['href', 'title', 'rel'],
    code: ['class'],
    pre: ['class'],
  },

  allowedSchemes: [
    'http',
    'https',
    'mailto',
  ],

  allowProtocolRelative: false,

  disallowedTagsMode: 'discard',

  parseStyleAttributes: false,

  transformTags: {
    a: sanitizeHtml.simpleTransform(
      'a',
      {
        rel: 'noopener noreferrer',
      },
      true
    ),
  },
};

// Decode HTML entities that could hide dangerous URLs.
function decodeUrlEntities(value) {
  let result = value;

  // Decode repeatedly to handle nested entity encoding.
  for (let i = 0; i < 3; i++) {
    result = result
      .replace(/&amp;/gi, '&')
      .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
        const code = parseInt(hex, 16);

        return code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '';
      })
      .replace(/&#(\d+);?/g, (_, number) => {
        const code = Number(number);

        return code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '';
      })
      .replace(/&colon;/gi, ':')
      .replace(/&tab;/gi, '\t')
      .replace(/&newline;/gi, '\n');
  }

  return result;
}

// Identify dangerous URL schemes.
function isUnsafeUrl(value) {
  const decoded = decodeUrlEntities(value)
    .replace(/^<|>$/g, '');

  const normalized = decoded
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .trim()
    .toLowerCase();

  return /^(javascript|vbscript|data):/.test(normalized);
}

// Neutralize dangerous URLs in Markdown links and images.
function sanitizeMarkdownLinks(content) {
  let result = content.replace(
    /(!?\[[^\]\n]*\]\()(\s*)(<[^>\n]*>|[^)\s]+)([^)\n]*\))/g,
    (match, prefix, spacing, destination, suffix) => {
      if (isUnsafeUrl(destination)) {
        return `${prefix}${spacing}#blocked${suffix}`;
      }

      return match;
    }
  );

  // Protect reference-style Markdown links.
  result = result.replace(
    /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]*>|[^\s]+)(.*)$/gm,
    (match, prefix, destination, suffix) => {
      if (isUnsafeUrl(destination)) {
        return `${prefix}#blocked${suffix}`;
      }

      return match;
    }
  );

  return result;
}

// Protect fenced code blocks and inline code.
function protectCodeSegments(content) {
  const protectedParts = new Map();

  function store(value) {
    const token =
      `CHATCODE${randomBytes(16).toString('hex')}END`;

    protectedParts.set(token, value);

    return token;
  }

  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  let result = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const opening = line
      .replace(/\r?\n$/, '')
      .match(/^ {0,3}(`{3,}|~{3,})(.*)$/);

    if (
      opening &&
      !(
        opening[1][0] === '`' &&
        opening[2].includes('`')
      )
    ) {
      const fenceCharacter = opening[1][0];
      const minimumLength = opening[1].length;

      let block = line;

      while (++i < lines.length) {
        const currentLine = lines[i];

        block += currentLine;

        const closing = currentLine
          .replace(/\r?\n$/, '')
          .match(/^ {0,3}(`+|~+)[ \t]*$/);

        if (
          closing &&
          closing[1][0] === fenceCharacter &&
          closing[1].length >= minimumLength
        ) {
          break;
        }
      }

      // Preserve the entire block, including an unclosed fence.
      result += store(block);

      continue;
    }

    result += line;
  }

  // Protect inline code outside fenced blocks.
  result = result.replace(
    /(`+)([\s\S]*?)\1/g,
    (match) => store(match)
  );

  return {
    content: result,
    protectedParts,
  };
}

/**
 * Main sanitization function.
 *
 * Preserves developer code as inert strings while
 * sanitizing potentially executable HTML.
 */
export function sanitizeContent(content) {
  if (typeof content !== 'string') {
    throw new TypeError(
      'Message content must be a string'
    );
  }

  // 1. Protect developer code.
  const protectedContent =
    protectCodeSegments(content);

  // 2. Sanitize dangerous Markdown URLs.
  const safeMarkdown = sanitizeMarkdownLinks(
    protectedContent.content
  );

  // 3. Sanitize raw HTML.
  let sanitized = sanitizeHtml(
    safeMarkdown,
    HTML_OPTIONS
  );

  // 4. Restore original code.
  for (
    const [token, original]
    of protectedContent.protectedParts
  ) {
    sanitized = sanitized
      .split(token)
      .join(original);
  }

  return sanitized;
}