import { describe, it, expect } from 'vitest';
import { sanitizeContentType } from '../routes/uploads.js';

describe('sanitizeContentType', () => {
  it('blocks text/html', () => {
    expect(sanitizeContentType('text/html')).toBe('application/octet-stream');
  });

  it('blocks text/html with charset parameter', () => {
    expect(sanitizeContentType('text/html; charset=utf-8')).toBe('application/octet-stream');
  });

  it('blocks application/xhtml+xml', () => {
    expect(sanitizeContentType('application/xhtml+xml')).toBe('application/octet-stream');
  });

  it('blocks image/svg+xml', () => {
    expect(sanitizeContentType('image/svg+xml')).toBe('application/octet-stream');
  });

  it('blocks text/xml', () => {
    expect(sanitizeContentType('text/xml')).toBe('application/octet-stream');
  });

  it('blocks application/xml', () => {
    expect(sanitizeContentType('application/xml')).toBe('application/octet-stream');
  });

  it('is case-insensitive', () => {
    expect(sanitizeContentType('Text/HTML')).toBe('application/octet-stream');
    expect(sanitizeContentType('IMAGE/SVG+XML')).toBe('application/octet-stream');
  });

  it('allows safe types through unchanged', () => {
    expect(sanitizeContentType('image/png')).toBe('image/png');
    expect(sanitizeContentType('image/jpeg')).toBe('image/jpeg');
    expect(sanitizeContentType('application/pdf')).toBe('application/pdf');
    expect(sanitizeContentType('text/plain')).toBe('text/plain');
    expect(sanitizeContentType('application/octet-stream')).toBe('application/octet-stream');
  });

  it('preserves parameters for safe types', () => {
    expect(sanitizeContentType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
  });
});
