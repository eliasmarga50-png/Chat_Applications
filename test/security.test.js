import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeContent,
} from '../src/utils/sanitizeContent.js';

import {
  validateMessagePayload,
  MAX_MESSAGE_CONTENT,
} from '../src/utils/messageValidation.js';

// ========================================
// MARKDOWN PRESERVATION
// ========================================

test('preserves normal Markdown formatting', () => {
  const input =
    '# Heading\n\n**Bold text** and *italic text*';

  assert.equal(
    sanitizeContent(input),
    input
  );
});

test('preserves fenced JavaScript code exactly', () => {
  const input = [
    'Example:',
    '',
    '```javascript',
    'const message = "<script>alert(1)</script>";',
    'console.log(message);',
    '```',
  ].join('\n');

  assert.equal(
    sanitizeContent(input),
    input
  );
});

test('preserves HTML examples inside fenced blocks', () => {
  const input = [
    '```html',
    '<script>alert("XSS")</script>',
    '<img src=x onerror=alert(1)>',
    '```',
  ].join('\n');

  assert.equal(
    sanitizeContent(input),
    input
  );
});

test('preserves inline code containing HTML', () => {
  const input =
    'Use `<script>alert(1)</script>` as an example.';

  assert.equal(
    sanitizeContent(input),
    input
  );
});

test('preserves unclosed Markdown code fences', () => {
  const input = [
    '```html',
    '<script>alert(1)</script>',
    '<img onerror=alert(1)>',
  ].join('\n');

  assert.equal(
    sanitizeContent(input),
    input
  );
});

test('preserves tilde-fenced code blocks', () => {
  const input = [
    '~~~javascript',
    'alert("example");',
    '~~~',
  ].join('\n');

  assert.equal(
    sanitizeContent(input),
    input
  );
});

// ========================================
// HTML SANITIZATION
// ========================================

test('removes executable script elements', () => {
  const input =
    '<script>alert("XSS")</script><p>Safe content</p>';

  const result = sanitizeContent(input);

  assert.doesNotMatch(result, /<script/i);
  assert.doesNotMatch(result, /alert\("XSS"\)/i);
  assert.match(result, /Safe content/);
});

test('removes HTML event handler attributes', () => {
  const input =
    '<p onclick="alert(1)">Hello</p>';

  const result = sanitizeContent(input);

  assert.doesNotMatch(result, /onclick/i);
  assert.match(result, /Hello/);
});

test('removes dangerous image HTML', () => {
  const input =
    '<img src="x" onerror="alert(1)">';

  const result = sanitizeContent(input);

  assert.doesNotMatch(result, /onerror/i);
  assert.doesNotMatch(result, /<img/i);
});

test('removes dangerous JavaScript HTML links', () => {
  const input =
    '<a href="javascript:alert(1)" onclick="alert(2)">Click</a>';

  const result = sanitizeContent(input);

  assert.doesNotMatch(result, /javascript:/i);
  assert.doesNotMatch(result, /onclick/i);
  assert.match(result, /Click/);
});

test('removes dangerous SVG elements', () => {
  const input =
    '<svg onload="alert(1)"><circle /></svg>';

  const result = sanitizeContent(input);

  assert.doesNotMatch(result, /<svg/i);
  assert.doesNotMatch(result, /onload/i);
});

test('preserves safe HTML formatting', () => {
  const input =
    '<p><strong>Hello</strong> developers</p>';

  const result = sanitizeContent(input);

  assert.equal(result, input);
});

test('adds safe relationship attributes to links', () => {
  const input =
    '<a href="https://example.com">Example</a>';

  const result = sanitizeContent(input);

  assert.match(
    result,
    /https:\/\/example\.com/
  );

  assert.match(
    result,
    /rel="noopener noreferrer"/
  );
});

// ========================================
// MARKDOWN URL PROTECTION
// ========================================

test('neutralizes JavaScript Markdown links', () => {
  const input =
    '[Click](javascript:alert(1))';

  const result = sanitizeContent(input);

  assert.doesNotMatch(
    result,
    /javascript:/i
  );

  assert.match(
    result,
    /#blocked/
  );
});

test('neutralizes dangerous Markdown image URLs', () => {
  const input =
    '![image](data:text/html,alert(1))';

  const result = sanitizeContent(input);

  assert.doesNotMatch(
    result,
    /data:text\/html/i
  );
});

test('neutralizes entity-obfuscated URL schemes', () => {
  const input =
    '[Click](java&#x73;cript:alert(1))';

  const result = sanitizeContent(input);

  assert.doesNotMatch(
    result,
    /javascript:/i
  );

  assert.match(
    result,
    /#blocked/
  );
});

test('preserves safe Markdown links', () => {
  const input =
    '[OpenAI](https://openai.com)';

  assert.equal(
    sanitizeContent(input),
    input
  );
});

// ========================================
// PAYLOAD VALIDATION
// ========================================

test('accepts a valid message payload', () => {
  const result = validateMessagePayload({
    slug: 'JavaScript',
    content: 'Hello developers',
  });

  assert.deepEqual(result, {
    slug: 'javascript',
    content: 'Hello developers',
  });
});

test('preserves whitespace in code content', () => {
  const content = [
    'function hello() {',
    '  console.log("Hello");',
    '}',
  ].join('\n');

  const result = validateMessagePayload({
    slug: 'javascript',
    content,
  });

  assert.equal(
    result.content,
    content
  );
});

test('rejects null payloads', () => {
  assert.throws(
    () => validateMessagePayload(null),
    { code: 'INVALID_PAYLOAD' }
  );
});

test('rejects array payloads', () => {
  assert.throws(
    () => validateMessagePayload([]),
    { code: 'INVALID_PAYLOAD' }
  );
});

test('rejects primitive payloads', () => {
  assert.throws(
    () => validateMessagePayload('hello'),
    { code: 'INVALID_PAYLOAD' }
  );
});

test('rejects unexpected payload fields', () => {
  assert.throws(
    () => validateMessagePayload({
      slug: 'javascript',
      content: 'Hello',
      role: 'admin',
    }),
    { code: 'INVALID_PAYLOAD' }
  );
});

test('rejects MongoDB query-like payload fields', () => {
  assert.throws(
    () => validateMessagePayload({
      slug: 'javascript',
      content: 'Hello',
      $where: 'return true',
    }),
    { code: 'INVALID_PAYLOAD' }
  );
});

test('rejects non-string message content', () => {
  assert.throws(
    () => validateMessagePayload({
      slug: 'javascript',
      content: { $ne: null },
    }),
    { code: 'INVALID_MESSAGE' }
  );
});

test('rejects empty messages', () => {
  assert.throws(
    () => validateMessagePayload({
      slug: 'javascript',
      content: '   ',
    }),
    { code: 'INVALID_MESSAGE' }
  );
});

test('rejects oversized messages', () => {
  assert.throws(
    () => validateMessagePayload({
      slug: 'javascript',
      content: 'A'.repeat(MAX_MESSAGE_CONTENT + 1),
    }),
    { code: 'INVALID_MESSAGE' }
  );
});

test('rejects invalid room slugs', () => {
  assert.throws(
    () => validateMessagePayload({
      slug: '../admin',
      content: 'Hello',
    }),
    { code: 'INVALID_ROOM_SLUG' }
  );
});